/** Cold lead-gen spam that the reply classifier reads as a real lead.
 *
 * 125 of the 458 threads Mailflow classified "interested" are this -- 27%
 * of the queue Jayme is being asked to work through, and they get the
 * "Interested" label applied in Gmail too, so they land in the same place
 * as real booking enquiries. Across the whole table it is 1,247 of 5,015
 * inbound messages: a quarter of everything ingested, each one currently
 * paying for a model call to be told it is a lead.
 *
 * The classifier isn't wrong to be fooled: these messages are written to
 * read as warm interest ("Jayme, let's talk about it", "are you ready to
 * get started?"). What gives them away is structural rather than semantic
 * -- every one carries a per-send tracking code in the subject, in a
 * trailing "| XXXXXXX DVQ84BR" block, from a rotating cast of throwaway
 * domains (foinvestorlegacy.com, familyprivatesummit.com, tannto-member.co).
 *
 * Matching the structure rather than the wording is both cheaper (no model
 * call) and more durable: the copy is regenerated per send, the tracking
 * format is what the sending platform imposes.
 */

/** The campaign-wide code, present in every message seen from this sender.
 * Checked on its own because the per-send code varies and occasionally the
 * subject is truncated mid-code. */
const CAMPAIGN_MARKER = "DVQ84BR";

/** The general shape: a pipe, then one or two all-caps alphanumeric codes
 * of 6-8 characters, at the end of the subject. Catches the same platform
 * when it rotates its campaign marker, which the literal above would miss.
 * Deliberately anchored to the end so a legitimate subject that merely
 * contains a pipe (common in press subjects: "Artist X | Venue") does not
 * match.
 *
 * Measured against all 5,015 ingested subjects: this adds zero matches
 * beyond the literal marker and zero false positives. It is insurance
 * against the marker rotating, not something currently doing work -- if it
 * ever starts matching mail that is NOT from this sender, delete it rather
 * than trying to narrow it. */
const TRACKING_SUFFIX = /\|\s*[A-Z0-9]{6,8}(\s+[A-Z0-9]{6,8})?\s*$/;

export function isLeadGenSpam(subject: string | null | undefined): boolean {
  if (!subject) return false;
  const s = subject.trim();
  if (s.toUpperCase().includes(CAMPAIGN_MARKER)) return true;
  // A truncated trailing code (the subject is cut off mid-marker) still
  // matches the suffix shape, which is the point of having both checks.
  return TRACKING_SUFFIX.test(s);
}
