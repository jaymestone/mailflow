/** Identity for a booking conversation, independent of Gmail's thread ids.
 *
 * One real conversation routinely spans several Gmail threads. Campaigns
 * send from whichever connected account round-robin picks, with Reply-To
 * pointing at a different one, so a venue's reply can arrive in two
 * mailboxes and each mints its own thread id -- frequently differing by a
 * single character, because they were minted moments apart
 * (1a0ca67d421dff24 and 1a0ca67e1ebaa1cb are both Carey Eyer's Blue Waters
 * thread). Measured over the live corpus: 42 of 333 interest thread ids
 * are a duplicate of a conversation already counted.
 *
 * Tempting shortcut, do not take it: treating ids that differ by one
 * character as the same thread. The near-identical pairs are an artifact
 * of when the ids were minted, not a rule -- the same corpus also contains
 * genuine duplicates whose ids look nothing alike (1a0abce591e38a8e and
 * 1a0efbb1fe86e42f, both Peter Cutler / Mountain Music). Edit distance
 * would merge some real pairs, miss others, and eventually merge two
 * unrelated threads.
 *
 * The durable identity is who the conversation is with plus what it is
 * about.
 */

/** Strips any run of reply/forward prefixes, in the several forms mail
 * clients produce, including the localised ones that turn up in European
 * venues' replies. */
const REPLY_PREFIX = /^(?:\s*(?:re|fwd?|aw|sv|vs|rif|antw|res)\s*(?:\[\d+\])?\s*:\s*)+/i;

export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  return subject
    .replace(REPLY_PREFIX, "")
    // Collapse whitespace so a client that rewrapped the header doesn't
    // produce a second conversation.
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The conversation's counterpart -- the venue's address, never one of
 * ours. A thread is identified by who it is with, so Jayme's own replies
 * must not change or split the key. */
export function threadKeyFor(counterpartEmail: string, subject: string | null | undefined): string {
  return `${counterpartEmail.trim().toLowerCase()}::${normalizeSubject(subject)}`;
}

/** Picks the counterpart from a thread's participants.
 *
 * Falls back to the first address seen when every participant is one of
 * ours -- that happens on internal forwards, and returning an empty key
 * there would collapse all such threads into one row.
 */
export function pickCounterpart(participants: string[], ownAddresses: Set<string>): string | null {
  const external = participants.find((p) => p && !ownAddresses.has(p.toLowerCase()));
  return external ?? participants.find((p) => Boolean(p)) ?? null;
}
