// Recovers the address a reply is actually answering, from the quoted
// original underneath it.
//
// A reply does not have to come from the address we mailed. Forwarders,
// shared mailboxes, assistants and org domain migrations all break that
// assumption, and when they do the From header names a *different* person
// or record than the one the sequence is pursuing.
//
// Confirmed live 2026-09-28. We mailed monag@pricechopper.com (contact
// "Second Wind Productions"). pricechopper.com forwards to Northeast
// Shared Services, so Mona replied -- "I retired Second Wind Productions
// in 2004 to concentrate on Music Haven", interested -- from
// mgolub@northeastsharedservices.com, which the list held as a SEPARATE
// contact record for the same human. Three things then went wrong at once:
//
//   1. The forwarder rewrote the threading headers. In-Reply-To came back
//      as a bare <...@mail.gmail.com> with no References chain, so it
//      never matched the rfc_message_id we generate at send time
//      (always @jaymestoneagency.com / @jaymestone.com) and header
//      matching fell through.
//   2. The sender_email fallback then resolved the From address to the
//      OTHER contact record and credited the reply there.
//   3. send_engine_who_is_due gates on matched_contact_id, so the record
//      that had actually been mailed never registered a reply at all --
//      it advanced to step 2 and sent her a second cold pitch twelve days
//      after she said she was interested.
//
// The quoted original still carried the truth: "To: monag@pricechopper.com".
// That is what this reads.

/** Header lines inside a quoted block that name who the original went to.
 * Gmail, Outlook and Apple Mail all emit some variant of these. */
const QUOTED_TO_LINE = /^\s*>*\s*(?:To|Cc|An|Para|A|À)\s*:\s*(.+)$/gim;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Where the quoted original begins. Everything above this is the human's
 * own words, and a "To:" there would be them writing a new address, not a
 * record of where our message landed. */
const QUOTE_MARKER =
  /\n\s*>*\s*(?:On\s.{0,160}wrote:|From:\s|-{2,}\s*(?:Original|Forwarded)\s*(?:Message|message)|_{5,}|Begin forwarded message:)/;

/** Addresses that are never a contact we mailed. */
const JUNK_LOCAL =
  /^(no-?reply|noreply|donotreply|do-not-reply|postmaster|mailer-daemon|bounce|unsubscribe|abuse|webmaster)$/i;

const localPart = (e: string) => e.toLowerCase().split("@")[0] ?? "";

/** Pulls the addresses the quoted original was addressed to.
 *
 * Deliberately limited to the quoted region and to explicit recipient
 * header lines: mining every address in the body would sweep up
 * signatures, colleagues mentioned in passing, and the sender's own
 * address, any of which would attribute a reply to the wrong contact --
 * a worse failure than the one this fixes.
 *
 * `exclude` should carry our own sending addresses and the reply's From
 * address, neither of which can be the forwarded-to recipient we want.
 */
export function extractQuotedRecipients(bodyText: string, exclude: string[]): string[] {
  const text = (bodyText ?? "").replace(/\r/g, "");
  const quoteStart = QUOTE_MARKER.exec(text);
  if (!quoteStart || quoteStart.index === undefined) return [];
  const quoted = text.slice(quoteStart.index);

  const skip = new Set(exclude.filter(Boolean).map((e) => e.toLowerCase()));
  const out: string[] = [];

  QUOTED_TO_LINE.lastIndex = 0;
  for (const line of quoted.matchAll(QUOTED_TO_LINE)) {
    for (const m of (line[1] ?? "").matchAll(EMAIL_RE)) {
      const addr = m[0].toLowerCase();
      if (skip.has(addr)) continue;
      if (JUNK_LOCAL.test(localPart(addr))) continue;
      if (out.includes(addr)) continue;
      out.push(addr);
    }
  }
  return out;
}
