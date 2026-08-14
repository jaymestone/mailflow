import type { ParsedEmail } from "@/lib/reply/types";

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function extractPlainText(payload: GmailPart): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  // Fall back to any body we can find (e.g. text/html) if no plain-text part exists.
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function header(headers: GmailHeader[], name: string): string | null {
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

function parseFromHeader(value: string): { email: string; name: string | null } {
  const match = value.match(/^(.*?)\s*<(.+?)>$/);
  if (match) {
    const name = match[1].replace(/"/g, "").trim();
    return { email: match[2].trim().toLowerCase(), name: name || null };
  }
  return { email: value.trim().toLowerCase(), name: null };
}

export async function fetchGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<ParsedEmail> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Gmail get message failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const headers: GmailHeader[] = data.payload?.headers ?? [];
  const from = parseFromHeader(header(headers, "From") ?? "");
  const referencesHeader = header(headers, "References");

  return {
    gmailMessageId: data.id,
    gmailThreadId: data.threadId,
    fromEmail: from.email,
    fromName: from.name,
    subject: header(headers, "Subject") ?? "",
    bodyText: extractPlainText(data.payload ?? {}),
    receivedAt: new Date(parseInt(data.internalDate, 10)).toISOString(),
    inReplyTo: header(headers, "In-Reply-To"),
    references: referencesHeader ? referencesHeader.split(/\s+/).filter(Boolean) : [],
    labelIds: data.labelIds ?? [],
  };
}
