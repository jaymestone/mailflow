// Rule-based pre-filter, checked before the LLM classifier. Ported from the
// old N8N classifier's bounce-detection logic: mailer-daemon sender, DSN
// subject/body keywords, and SMTP status codes — extended to distinguish
// hard (permanent) from soft (temporary) bounces, since only a hard bounce
// means the address is actually dead. A soft bounce (mailbox full, greylisted,
// server temporarily down) can resolve on its own; treating it the same as a
// hard bounce would suppress and delete addresses that are still good.

const MAILER_DAEMON_PATTERNS = [
  /mailer-daemon/i,
  /postmaster@/i,
  /mail delivery subsystem/i,
  /mail delivery system/i,
  /delivery status notification/i,
];

const DSN_SUBJECT_PATTERNS = [
  /undeliver(ed|able)/i,
  /delivery status notification/i,
  /delivery has failed/i,
  /returned to sender/i,
  /mail delivery failed/i,
  /failure notice/i,
  /message not delivered/i,
];

// SMTP Enhanced Status Codes (RFC 3463): the first digit is the severity —
// 5.x.x is a Permanent Failure, 4.x.x is a Persistent Transient Failure.
const HARD_SMTP_CODE = /\b5\.\d\.\d{1,3}\b/;
const SOFT_SMTP_CODE = /\b4\.\d\.\d{1,3}\b/;

// Free-text language DSNs commonly use for a genuinely dead address.
const HARD_BOUNCE_BODY_PATTERNS = [
  /does not exist/i,
  /no such user/i,
  /user (unknown|not found)/i,
  /unknown user/i,
  /address rejected/i,
  /invalid (recipient|mailbox|address)/i,
  /mailbox (unavailable|not found)/i,
  /recipient address rejected/i,
  /no mailbox here/i,
  /account.*(disabled|closed)/i,
];

// Free-text language DSNs commonly use for a temporary condition — the
// address itself is fine, delivery just didn't go through this time.
const SOFT_BOUNCE_BODY_PATTERNS = [
  /mailbox full/i,
  /over quota/i,
  /quota exceeded/i,
  /try again later/i,
  /temporarily (deferred|unavailable|rejected)/i,
  /greylist/i,
  /connection timed out/i,
  /rate limit/i,
  /throttl/i,
  /message (delayed|deferred)/i,
];

export type BounceClassification = {
  isBounce: boolean;
  /** Only meaningful when isBounce is true. False covers both confirmed-soft
   * and ambiguous cases (a DSN with no explicit hard signal) — deliberately
   * conservative, since acting on an ambiguous bounce as if it were
   * permanent is the failure mode this exists to avoid. */
  isHard: boolean;
};

export function classifyBounce(opts: {
  fromEmail: string;
  subject: string;
  bodyText: string;
}): BounceClassification {
  const looksLikeDsn =
    MAILER_DAEMON_PATTERNS.some((p) => p.test(opts.fromEmail)) ||
    DSN_SUBJECT_PATTERNS.some((p) => p.test(opts.subject));
  const hasHardCode = HARD_SMTP_CODE.test(opts.bodyText);
  const hasSoftCode = SOFT_SMTP_CODE.test(opts.bodyText);
  const hasHardLanguage = HARD_BOUNCE_BODY_PATTERNS.some((p) => p.test(opts.bodyText));
  const hasSoftLanguage = SOFT_BOUNCE_BODY_PATTERNS.some((p) => p.test(opts.bodyText));

  const isBounce = looksLikeDsn || hasHardCode || hasSoftCode || hasHardLanguage || hasSoftLanguage;
  if (!isBounce) return { isBounce: false, isHard: false };

  return { isBounce: true, isHard: hasHardCode || hasHardLanguage };
}

/** Convenience wrapper for callers that only need the yes/no. */
export function isBounceMessage(opts: { fromEmail: string; subject: string; bodyText: string }): boolean {
  return classifyBounce(opts).isBounce;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A DSN's own From: header is always the *sending* mail server
 * (mailer-daemon@, postmaster@, etc.) — never the real recipient whose
 * address actually failed. When In-Reply-To/References threading can't
 * match a bounce back to the original send (broken or stripped by the
 * recipient's mail system — common with several corporate/Exchange
 * senders, confirmed live 2026-09-16: 49 real hard bounces sat unmatched
 * this way in one day, silently leaving their contacts unsuppressed and
 * un-paused), the DSN body itself almost always still names the failed
 * address directly ("the following addresses had permanent fatal
 * errors", "wasn't delivered to X because...", etc.). Returns every
 * candidate found, in order, for the caller to check against real
 * contacts -- deliberately not narrowed further here, since which
 * candidate is real depends on data this module doesn't have (the
 * contacts table). `excludeEmails` filters out addresses that can't be
 * the failed recipient on their face: the DSN's own sender, and every one
 * of this system's own sending accounts (which can legitimately appear
 * quoted in the bounce's copy of the original failed message). */
export function extractBouncedRecipientCandidates(bodyText: string, excludeEmails: string[]): string[] {
  const exclude = new Set(excludeEmails.map((e) => e.toLowerCase()));
  const found = bodyText.match(EMAIL_PATTERN) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase()))].filter((e) => !exclude.has(e));
}
