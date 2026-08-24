/** Escapes text and turns `[label](url)` markdown-lite links (inserted via
 * the step editor's Link button) into real `<a>` tags — the shared core
 * used both for the actual outbound HTML email and for rendering a
 * resolved preview inline in the app's own UI (which supplies its own
 * text styling, unlike the email-specific wrapper below). */
export function linkifyMarkdown(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
}

/** Wraps a fully-assembled inner HTML string (new content, quote
 * attribution, and quoted blockquote all included) in the one font/size
 * declaration for the whole email. Everything must go inside a single call
 * to this — wrapping pieces separately leaves the unwrapped parts to fall
 * back to whatever default font size the recipient's client uses, which
 * doesn't match the declared 14px and reads as visibly inconsistent. */
export function wrapEmailHtml(innerHtml: string): string {
  return `<div style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">${innerHtml}</div>`;
}

/** Convenience for the simple case (no quote block involved): escapes,
 * linkifies, and wraps a single plain-text string in one step. */
export function renderPlainTextToHtml(text: string): string {
  return wrapEmailHtml(linkifyMarkdown(text).replace(/\n/g, "<br>"));
}

/** Wraps inner HTML in a quoted-reply visual style — a colored left border
 * and matching text tint, the way Mail.app (and most desktop mail clients)
 * render a quote, rather than literal ">" characters carried over from
 * plain-text quoting convention. No font-size here on purpose: it must
 * inherit from the single wrapEmailHtml() wrapper around the whole email
 * so the quote reads at the same size as the new text above it. */
export function wrapInGmailQuote(innerHtml: string): string {
  return `<blockquote style="margin:0 0 0 0.8ex;border-left:3px solid #6b7fd7;padding-left:1ex;color:#4a55a2;">${innerHtml}</blockquote>`;
}

/** Matches Apple Mail's own reply-attribution phrasing ("On Aug 21, 2026,
 * at 11:53 AM, Name <email> wrote:") rather than a generic
 * weekday-inclusive timestamp — this is specifically what recipients used
 * to Mail.app expect a genuine reply to look like.
 *
 * `timeZone` should be the sender's configured zone (e.g. the send window's
 * timezone in app_settings) — without it, `Date`'s formatting falls back to
 * wherever the Node process happens to be running, which on a server this
 * isn't deployed near can silently show recipients a time several hours
 * off from when the original email actually went out. */
export function formatQuoteAttribution(sentAt: string | null, senderLabel: string, timeZone?: string): string {
  if (!sentAt) return `${senderLabel} wrote:`;
  const date = new Date(sentAt);
  const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
  const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return `On ${dateStr}, at ${timeStr}, ${senderLabel} wrote:`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
