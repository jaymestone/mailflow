import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

// Matches the same `[label](url)` shape rich-body-extensions.tsx's TOKEN_RE
// and emailHtml.ts's linkifyMarkdown already use for the step editor's
// markdown-lite links -- this only needs the link half of that syntax.
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export type PendingLinkToken = {
  token: string;
  label: string;
  destination_url: string;
};

/** Pure: finds every markdown-lite link in `body` and returns the body
 * with each URL replaced by `${baseUrl}/api/r/{token}`, plus the token
 * rows that need inserting for those replacements to resolve anywhere.
 * Kept separate from the DB write below so the rewrite itself -- the part
 * with any real logic -- is unit-testable without a Supabase client. */
export function rewriteLinksForTracking(body: string, baseUrl: string): { body: string; tokens: PendingLinkToken[] } {
  const matches = [...body.matchAll(MARKDOWN_LINK_RE)];
  if (matches.length === 0) return { body, tokens: [] };

  const tokens: PendingLinkToken[] = matches.map((m) => ({
    token: randomBytes(9).toString("base64url"),
    label: m[1],
    destination_url: m[2],
  }));

  // Rebuilt by index rather than repeated string .replace() -- two links
  // can legitimately share an identical "[label](url)" (e.g. the same
  // artist linked twice), and .replace() only ever touches the first
  // occurrence, which would point both at the same token and silently
  // conflate two distinct link positions into one.
  let result = "";
  let lastIndex = 0;
  matches.forEach((m, i) => {
    result += body.slice(lastIndex, m.index);
    result += `[${tokens[i].label}](${baseUrl}/api/r/${tokens[i].token})`;
    lastIndex = m.index! + m[0].length;
  });
  result += body.slice(lastIndex);

  return { body: result, tokens };
}

/** Rewrites `body`'s links to click-tracking redirects and records which
 * (contact, campaign, step) each token belongs to, so a later click can be
 * attributed back to a specific artist link this specific recipient was
 * sent. Fails open -- returns `body` untouched if APP_BASE_URL isn't
 * configured or the insert errors, since a tracking hiccup must never
 * block a real send from going out. */
export async function injectClickTracking(
  supabase: SupabaseClient,
  body: string,
  ctx: { contactId: string; campaignId: string; stepNumber: number },
): Promise<string> {
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) return body;

  const { body: rewritten, tokens } = rewriteLinksForTracking(body, baseUrl);
  if (tokens.length === 0) return body;

  const { error } = await supabase.from("link_tokens").insert(
    tokens.map((t) => ({
      token: t.token,
      campaign_id: ctx.campaignId,
      contact_id: ctx.contactId,
      step_number: ctx.stepNumber,
      label: t.label,
      destination_url: t.destination_url,
    })),
  );
  if (error) return body;

  return rewritten;
}
