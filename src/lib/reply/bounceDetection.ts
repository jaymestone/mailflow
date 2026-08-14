// Rule-based pre-filter, checked before the LLM classifier. Ported from the
// old N8N classifier's bounce-detection logic: mailer-daemon sender, DSN
// subject/body keywords, and SMTP 5.x status codes.

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

const SMTP_FAILURE_CODE = /\b5\.\d\.\d{1,3}\b/;

export function isBounceMessage(opts: {
  fromEmail: string;
  subject: string;
  bodyText: string;
}): boolean {
  if (MAILER_DAEMON_PATTERNS.some((p) => p.test(opts.fromEmail))) return true;
  if (DSN_SUBJECT_PATTERNS.some((p) => p.test(opts.subject))) return true;
  if (SMTP_FAILURE_CODE.test(opts.bodyText)) return true;
  return false;
}
