import { escapeHtml, formatQuoteAttribution, linkifyMarkdown, wrapInGmailQuote } from "@/lib/templates/emailHtml";

type ChainAccount = { email_address: string; display_name: string | null };

export type PriorSend = {
  step_number: number;
  subject_resolved: string;
  body_resolved: string;
  sent_at: string | null;
  rfc_message_id: string | null;
  gmail_thread_id: string | null;
  connected_account_id: string;
  // Supabase returns a related row as an object normally, but as a single-
  // element array under some query shapes — both are handled the same way
  // the rest of this codebase already does.
  connected_account: ChainAccount | ChainAccount[] | null;
};

export type FollowUpContent = {
  finalSubject: string;
  finalBody: string;
  /** Unwrapped inner HTML — the caller wraps it once via wrapEmailHtml(). */
  htmlInner: string;
  inReplyTo: string | undefined;
  references: string | undefined;
  threadId: string | undefined;
};

/**
 * Composes the subject/body/HTML/threading-header fields for a campaign
 * step, filling in the "Re: [step 1 subject]" default and step-1-only
 * visible quote for follow-up steps (next_step > 1). Pure and side-effect
 * free — no Supabase calls — so `chain` (every prior *sent* step for this
 * member, oldest first) must already be fetched by the caller.
 *
 * Mirrors send/tick.ts's inline composition exactly: step 1 is always what
 * gets quoted (never the immediately preceding step, so a long sequence
 * doesn't pile up nested quotes), while References/In-Reply-To reflect the
 * full, RFC 5322-correct ancestor chain regardless of which step is shown.
 */
export function buildFollowUpContent(opts: {
  subject: string;
  body: string;
  nextStep: number;
  chain: PriorSend[];
  currentAccountId: string;
  timezone?: string;
}): FollowUpContent {
  let finalSubject = opts.subject;
  let finalBody = opts.body;
  let htmlInner = linkifyMarkdown(opts.body).replace(/\n/g, "<br>");
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;

  if (opts.nextStep > 1) {
    const chain = opts.chain;
    const original = chain.find((r) => r.step_number === 1);
    const mostRecent = chain[chain.length - 1];

    if (original) {
      if (!finalSubject.trim()) {
        finalSubject = `Re: ${original.subject_resolved}`;
      }

      const originalAccount = Array.isArray(original.connected_account)
        ? original.connected_account[0]
        : original.connected_account;
      const senderLabel = originalAccount?.display_name
        ? `${originalAccount.display_name} <${originalAccount.email_address}>`
        : (originalAccount?.email_address ?? "");
      const attribution = formatQuoteAttribution(original.sent_at, senderLabel, opts.timezone);

      const quotedPlain = original.body_resolved
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      finalBody = `${finalBody}\n\n${attribution}\n${quotedPlain}`;

      const quotedHtmlInner = linkifyMarkdown(original.body_resolved).replace(/\n/g, "<br>");
      htmlInner = `${htmlInner}<br><br>` + wrapInGmailQuote(`${escapeHtml(attribution)}<br>${quotedHtmlInner}`);
    }

    const chainIds = chain.map((r) => r.rfc_message_id).filter((id): id is string => Boolean(id));
    if (chainIds.length > 0) {
      references = chainIds.join(" ");
      inReplyTo = chainIds[chainIds.length - 1];
    }

    if (mostRecent?.gmail_thread_id && mostRecent.connected_account_id === opts.currentAccountId) {
      threadId = mostRecent.gmail_thread_id;
    }
  }

  return { finalSubject, finalBody, htmlInner, inReplyTo, references, threadId };
}
