import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshAccessToken } from "@/lib/oauth/google";

/** Mints a fresh access token for a connected account from its stored
 * refresh token. Always calls Google (no access-token caching) since this
 * is invoked at most a few times per background job run. */
export async function getAccessToken(supabase: SupabaseClient, accountId: string): Promise<string> {
  const { data: refreshToken, error } = await supabase.rpc("get_oauth_refresh_token", {
    p_account_id: accountId,
  });
  if (error || !refreshToken) throw new Error("No refresh token stored for this account");

  const tokens = await refreshAccessToken(refreshToken);
  return tokens.access_token;
}

function buildRawMessage(opts: { from: string; to: string; subject: string; body: string; replyTo?: string }) {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
    `Subject: ${opts.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
  ]
    .filter(Boolean)
    .join("\r\n");
  const message = `${headers}\r\n\r\n${opts.body}`;
  return Buffer.from(message).toString("base64url");
}

export async function sendGmailMessage(
  accessToken: string,
  opts: { from: string; to: string; subject: string; body: string; replyTo?: string },
): Promise<{ id: string; threadId: string }> {
  const raw = buildRawMessage(opts);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  return res.json();
}
