// Corporate/hosted email security scanners (Outlook Safe Links, Proofpoint,
// Mimecast, Barracuda, and similar) routinely "click" every link in an
// email within seconds of delivery to scan its destination for malware --
// well before any human has opened the message. Left unflagged, that
// automated traffic would swamp real click signal, especially for venues
// on a corporate/institutional domain. Two independent heuristics, either
// one enough to flag a click as likely-bot: the user-agent self-identifies
// as a scanner, or the click landed suspiciously soon after the link was
// minted (≈ send time) for a human to plausibly have opened the email,
// read it, and clicked -- this second check also catches scanners that
// don't identify themselves in their user-agent at all.

const BOT_USER_AGENT_PATTERNS = [
  /safelinks/i,
  /proofpoint/i,
  /mimecast/i,
  /barracuda/i,
  /symantec/i,
  /trend ?micro/i,
  /forcepoint/i,
  /ironport/i,
  /googleimageproxy/i,
  /bot|crawler|spider/i,
];

export function looksLikeBotUserAgent(userAgent: string): boolean {
  return BOT_USER_AGENT_PATTERNS.some((re) => re.test(userAgent));
}

export function isSuspiciouslyFast(tokenCreatedAt: string, clickedAt: Date, thresholdMs = 10_000): boolean {
  return clickedAt.getTime() - new Date(tokenCreatedAt).getTime() < thresholdMs;
}

export function detectLikelyBot(userAgent: string, tokenCreatedAt: string, clickedAt: Date = new Date()): boolean {
  return looksLikeBotUserAgent(userAgent) || isSuspiciouslyFast(tokenCreatedAt, clickedAt);
}
