export const GMAIL_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export function getCallbackUrl(origin: string) {
  return `${origin}/api/oauth/google/callback`;
}

export function buildAuthUrl(origin: string, state: string) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: getCallbackUrl(origin),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_OAUTH_SCOPES.join(" "),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

export async function exchangeCodeForTokens(code: string, origin: string): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: getCallbackUrl(origin),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Thrown only when Google itself confirms a refresh token is dead
 * (revoked, expired, or otherwise permanently invalid) — the one failure
 * mode that actually requires a human to reconnect the account. Every
 * other failure from this module (a timeout, a 5xx, a rate limit) is a
 * plain Error, meaning "try again later," not "this account is broken." */
export class OAuthTokenRevokedError extends Error {
  constructor(detail: string) {
    super(`OAuth token revoked: ${detail}`);
    this.name = "OAuthTokenRevokedError";
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Google's token endpoint returns 400 + {"error":"invalid_grant"}
    // specifically when a refresh token has been revoked or expired. Any
    // other non-OK response (a 5xx, a 429, a transient network error
    // surfaced as a non-JSON body) is not a confirmed-dead token.
    let isInvalidGrant = false;
    try {
      isInvalidGrant = JSON.parse(body)?.error === "invalid_grant";
    } catch {
      // Non-JSON body -- fall through as a generic (retryable) failure.
    }
    if (isInvalidGrant) throw new OAuthTokenRevokedError(body);
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  return res.json();
}

/** Decodes the id_token JWT payload without verifying the signature — safe
 * here because it came directly from Google's token endpoint over TLS in a
 * server-to-server exchange, not from anything user-suppliable. */
export function decodeIdTokenEmail(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json);
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
