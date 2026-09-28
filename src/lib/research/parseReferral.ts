// Extracts the replacement contact a venue has already handed us.
//
// When someone leaves, their auto-reply usually names their successor
// outright: "Please reach out to Matt Dettmer (mdettmer@warnertheatre.org)".
// 468 of 836 departed/out-of-office replies in the list do this — 56%.
//
// That is free, and more reliable than web research, because the venue
// itself supplied the name. The paid alternative
// (src/lib/research/findReplacement.ts) researched 234 venues for a 5.6%
// hit rate, one mailed contact and zero replies. This reads text we
// already have.

export type Referral = {
  email: string;
  /** Name sitting immediately around the address, when there is one. */
  name: string | null;
  /** high   = a pointing phrase, and the address is at the same organisation
   *  medium = a pointing phrase, but a third-party domain
   *  low    = no pointing phrase; this was simply the only other address present */
  confidence: "high" | "medium" | "low";
  /** The sentence it came from, so a human can check the call. */
  evidence: string;
  /** True when the address is a role account (info@, booking@) rather than
   * a person. Still useful, but worth knowing before it's mailed. */
  isRoleAddress: boolean;
};

/** Phrases that hand you someone else. Ordered loosely by how strongly
 * they imply a real handover. */
const POINTERS = [
  /please\s+(?:contact|reach\s+out\s+to|email|direct\s+(?:your|all)?\s*(?:enquiries|inquiries|queries)?\s*to|write\s+to)/i,
  /(?:reach\s+out|reach)\s+to/i,
  /(?:for|with)\s+(?:assistance|immediate\s+assistance|any\s+)?(?:questions|queries|enquiries|inquiries|help|booking|bookings)[^.!?\n]{0,40}(?:contact|email|to)/i,
  /(?:has\s+)?(?:taken\s+over|replacing\s+me|now\s+handling|is\s+now\s+handling|will\s+be\s+handling)/i,
  /(?:my\s+)?(?:colleague|successor|replacement)/i,
  /(?:best|right|correct)\s+(?:liaison|contact|person)/i,
  /in\s+my\s+(?:absence|place|stead)/i,
  /(?:i'?m|i\s+am)\s+(?:cc'?ing|copying|forwarding)/i,
  /(?:forwarded|forwarding|sent|passed)\s+(?:your|this|it)\s+(?:email|message|note|information|along|on)?\s*to/i,
  /instead[,:]?\s/i,
  /new\s+(?:executive\s+)?(?:director|contact|manager|coordinator)/i,
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Addresses that are never a useful onward contact. */
const JUNK_LOCAL = /^(no-?reply|noreply|donotreply|do-not-reply|postmaster|mailer-daemon|bounce|unsubscribe|abuse|webmaster|privacy|legal|support\+|notifications?)$/i;
const JUNK_DOMAIN = /(^|\.)(sentry\.io|urldefense\.com|proofpoint\.com|schema\.org|w3\.org|example\.com|googleapis\.com|gstatic\.com|sentry-cdn\.com|list-manage\.com|mailchimp\.com|constantcontact\.com|cloudfront\.net|wixpress\.com|squarespace\.com|shopify\.com)$/i;

const ROLE_LOCAL = /^(info|booking|bookings|music|events?|contact|office|admin|tickets?|boxoffice|box-office|hello|mail|arts|concerts|programm?(?:ing|es?)?|director|talent|press|marketing|general|frontdesk|reception|theat(?:re|er)|education|artistic|submissions?|welcome|enquiries|inquiries|team)$/i;

const localPart = (e: string) => e.toLowerCase().split("@")[0] ?? "";
const domainOf = (e: string) => e.toLowerCase().split("@")[1] ?? "";

/** Strips the quoted history, signature boilerplate and HTML so pointer
 * phrases aren't matched against an old thread. */
export function topOfReply(body: string): string {
  let t = (body ?? "").replace(/\r/g, "").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  t = t.split(
    /\n(?:On\s.{0,120}wrote:|From:\s|_{5,}|-{3,}\s*Original|Sent from my|Get Outlook|Dne\s\d)/,
  )[0];
  t = t
    .split("\n")
    .filter((l) => !l.trim().startsWith(">"))
    .join("\n");
  // mailto: links duplicate every address; keep the text, drop the wrapper
  t = t.replace(/<mailto:[^>]*>/gi, " ").replace(/\[cid:[^\]]*\]/gi, " ");
  t = t.replace(/<[^>]{1,200}>/g, " ");
  return t.replace(/[ \t]+/g, " ");
}

/** Pulls a personal name out of the words immediately around an address.
 * "Please reach out to Matt Dettmer (mdettmer@..." -> "Matt Dettmer" */
function nameNear(text: string, at: number): string | null {
  const before = text.slice(Math.max(0, at - 70), at);
  const m = [...before.matchAll(/\b([A-Z][a-z]{1,15})\s+([A-Z][a-z'\-]{1,20})\b/g)];
  if (m.length === 0) return null;
  const last = m[m.length - 1];
  // Reject sentence-openers that merely look like names
  if (/^(Thank|Please|Dear|Best|Kind|Many|For|Our|The|This|Hi|Hello|Good)$/i.test(last[1])) return null;
  return `${last[1]} ${last[2]}`;
}

export type ParseOptions = {
  /** The address that sent the auto-reply — never referred to itself. */
  senderEmail: string;
  /** Our own addresses, which appear in every quoted reply. */
  ownDomains?: string[];
};

const DEFAULT_OWN = ["jaymestone.com", "jaymestoneagency.com", "risingappalachia.com"];

/** Returns the single best onward contact, or null when the reply names
 * nobody. Deliberately conservative: a wrong address wastes a send and
 * looks careless to a venue. */
export function parseReferral(body: string, opts: ParseOptions): Referral | null {
  const text = topOfReply(body);
  if (!text.trim()) return null;

  const own = new Set((opts.ownDomains ?? DEFAULT_OWN).map((d) => d.toLowerCase()));
  const sender = (opts.senderEmail ?? "").toLowerCase();
  const senderDomain = domainOf(sender);

  type Hit = { email: string; index: number };
  const hits: Hit[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0];
    const lower = email.toLowerCase();
    if (lower === sender) continue;
    if (own.has(domainOf(lower))) continue;
    if (JUNK_LOCAL.test(localPart(lower))) continue;
    if (JUNK_DOMAIN.test(domainOf(lower))) continue;
    if (hits.some((h) => h.email.toLowerCase() === lower)) continue;
    hits.push({ email, index: m.index ?? 0 });
  }
  if (hits.length === 0) return null;

  // Where does the reply actually point at someone?
  const pointerAt: number[] = [];
  for (const p of POINTERS) {
    const m = p.exec(text);
    if (m?.index !== undefined) pointerAt.push(m.index);
  }

  const WINDOW = 220;
  const scored = hits.map((h) => {
    const nearest = pointerAt.length
      ? Math.min(...pointerAt.map((p) => (h.index >= p ? h.index - p : Number.POSITIVE_INFINITY)))
      : Number.POSITIVE_INFINITY;
    const pointed = nearest <= WINDOW;
    const sameOrg = domainOf(h.email) === senderDomain;
    const role = ROLE_LOCAL.test(localPart(h.email));
    // A named person at the same organisation, explicitly pointed at, is
    // the thing we want. Role accounts and third parties are fallbacks.
    let score = 0;
    if (pointed) score += 100 - Math.min(nearest, WINDOW) / 10;
    if (sameOrg) score += 40;
    if (!role) score += 20;
    return { ...h, pointed, sameOrg, role, score, nearest };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // With no pointing phrase at all, only accept a lone same-organisation
  // address — anything else is probably a signature or a footer.
  if (!best.pointed && !(best.sameOrg && hits.length === 1)) return null;

  const confidence: Referral["confidence"] = best.pointed ? (best.sameOrg ? "high" : "medium") : "low";

  // Sentence bounds must be found OUTSIDE the address — an email contains
  // dots, so searching for "." from the address's start cuts it in half
  // ("parks@pocatello." instead of "parks@pocatello.us").
  const afterEmail = best.index + best.email.length;
  const sentenceStart = Math.max(0, text.lastIndexOf(". ", best.index - 1) + 1);
  const endMatch = /[.!?](?=\s|$)/.exec(text.slice(afterEmail));
  const sentenceEnd = endMatch ? afterEmail + (endMatch.index ?? 0) + 1 : afterEmail;
  const evidence = text.slice(sentenceStart, sentenceEnd).replace(/\s+/g, " ").trim();

  return {
    email: best.email,
    name: nameNear(text, best.index),
    confidence,
    evidence: evidence.slice(0, 240),
    isRoleAddress: best.role,
  };
}
