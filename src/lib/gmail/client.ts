import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { refreshAccessToken } from "@/lib/oauth/google";

/** Reads the stored refresh token via a couple of short retries before
 * giving up -- a bare empty/errored response here used to be treated as
 * "this account has no token," which turned out to also catch a plain
 * transient Supabase/Vault read hiccup and permanently bench a perfectly
 * healthy account. A real, permanently-missing token still ends up
 * throwing the same error after retries exhaust; a one-off blip now just
 * self-heals within this same call instead. */
async function fetchRefreshToken(supabase: SupabaseClient, accountId: string): Promise<string> {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data, error } = await supabase.rpc("get_oauth_refresh_token", { p_account_id: accountId });
    if (!error && data) return data;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw new Error("No refresh token stored for this account");
}

/** Mints a fresh access token for a connected account from its stored
 * refresh token. Always calls Google (no access-token caching) since this
 * is invoked at most a few times per background job run. */
export async function getAccessToken(supabase: SupabaseClient, accountId: string): Promise<string> {
  const refreshToken = await fetchRefreshToken(supabase, accountId);
  const tokens = await refreshAccessToken(refreshToken);
  return tokens.access_token;
}

type SendMessageOpts = {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** When given, the message is sent as multipart/alternative (this HTML
   * version alongside the plain-text `body` as a fallback) — required for
   * an inserted link to actually render as a clickable hyperlink instead of
   * showing a raw URL. Omit for a plain-text-only send. */
  html?: string;
  replyTo?: string;
  /** Set as the RFC 5322 Message-ID header (format: "<id@domain>") — the
   * reply-matching pipeline looks up inbound In-Reply-To/References against
   * whatever value is stored as outbound_sends.rfc_message_id, so it must
   * actually be present on the sent message, not just recorded locally. */
  messageId: string;
  /** Both set to the referenced message's rfc_message_id to thread a
   * follow-up step as a reply. */
  inReplyTo?: string;
  references?: string;
  /** Gmail thread IDs are scoped to the mailbox that owns them — only pass
   * this when sending from the same account whose thread it is. */
  threadId?: string;
};

/** Header values are inherently single-line — a value containing an
 * embedded CR/LF would otherwise let whoever controls that value (e.g. a
 * merge field resolved from contact data) inject an arbitrary extra header
 * (a hidden Bcc, a corrupted Content-Type) into the raw MIME message. This
 * is the actual sink, so sanitizing here catches every path a value could
 * take to get here, not just the ones sanitized upstream. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Formats a From/Reply-To style address as `"Display Name" <email>` so
 * recipients see a real name instead of a bare address — without a
 * display name, a bare `From: j@x.com` header shows just the address (or
 * whatever generic label the recipient's client falls back to), never the
 * account's actual name. A literal `"` in the name would prematurely close
 * the quoted-string per RFC 5322, so it's escaped rather than stripped. */
export function formatFromAddress(displayName: string | null, email: string): string {
  if (!displayName?.trim()) return email;
  return `"${displayName.trim().replace(/"/g, '\\"')}" <${email}>`;
}

function buildRawMessage(opts: SendMessageOpts) {
  const baseHeaders = [
    `From: ${sanitizeHeaderValue(opts.from)}`,
    `To: ${sanitizeHeaderValue(opts.to)}`,
    opts.replyTo ? `Reply-To: ${sanitizeHeaderValue(opts.replyTo)}` : null,
    `Subject: ${sanitizeHeaderValue(opts.subject)}`,
    `Message-ID: ${sanitizeHeaderValue(opts.messageId)}`,
    opts.inReplyTo ? `In-Reply-To: ${sanitizeHeaderValue(opts.inReplyTo)}` : null,
    opts.references ? `References: ${sanitizeHeaderValue(opts.references)}` : null,
  ].filter(Boolean);

  if (!opts.html) {
    const headers = [...baseHeaders, "Content-Type: text/plain; charset=UTF-8"].join("\r\n");
    return Buffer.from(`${headers}\r\n\r\n${opts.body}`).toString("base64url");
  }

  const boundary = `mailflow_${randomBytes(12).toString("hex")}`;
  const headers = [...baseHeaders, `Content-Type: multipart/alternative; boundary="${boundary}"`].join("\r\n");
  const message = [
    headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    opts.body,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    opts.html,
    "",
    `--${boundary}--`,
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

export async function sendGmailMessage(
  accessToken: string,
  opts: SendMessageOpts,
): Promise<{ id: string; threadId: string }> {
  const raw = buildRawMessage(opts);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw, ...(opts.threadId ? { threadId: opts.threadId } : {}) }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  return res.json();
}
