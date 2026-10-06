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
 * venues' replies -- and the tags a venue's mail server stamps in front of
 * them: "[EXTERNAL]", "[spam]", "***SPAM***", "**EXT**", "[Use caution
 * when clicking links - 109]". Those arrive mid-thread, so leaving them in
 * gave the same conversation a second key and a second row on the board;
 * 16 rows carried one. They can come in any order with the reply prefixes
 * ("***SPAM*** Fwd: FW:", "[External]:Re:"), hence one alternation. */
const REPLY_PREFIX =
  /^(?:\s*(?:(?:re|fwd?|aw|sv|vs|rif|antw|res)\s*(?:\[\d+\])?\s*:|\[[^\]]*\]\s*:?|\*{1,3}[^*]+\*{1,3}\s*:?)\s*)+/i;

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

/** Jayme's mail domains. Every address at these is his, connected to
 * Mailflow or not -- admin@ and jayme@jaymestone.com are not connected
 * accounts, yet both turn up in threads. */
const OWN_DOMAINS = ["jaymestone.com", "jaymestoneagency.com"];

export function isOwnAddress(email: string | null | undefined, ownAddresses: Set<string>): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return ownAddresses.has(e) || OWN_DOMAINS.includes(e.split("@")[1] ?? "");
}

/** Picks the counterpart from a thread's participants: the first one,
 * oldest message first, who is not Jayme.
 *
 * Returns null when every participant is his. That used to fall back to
 * his own address, which is how 11 rows on the board ended up keyed to
 * stone@ or admin@ -- his reply, landing in another of his mailboxes, was
 * filed as a conversation with himself rather than as his side of the
 * venue's. A thread with no outside participant is not a booking
 * conversation, so it is skipped.
 */
export function pickCounterpart(participants: string[], ownAddresses: Set<string>): string | null {
  return participants.find((p) => p && !isOwnAddress(p, ownAddresses)) ?? null;
}

/** A stable identity for the thread a message belongs to: the Message-ID
 * of the thread's first message.
 *
 * Gmail thread ids are per mailbox, and Jayme's conversations routinely
 * span several of his. The first Message-ID is the same in all of them:
 * every reply's References header starts with it (RFC 5322 3.6.4), and a
 * reply to a campaign email carries that email's own Message-ID there.
 * In-Reply-To is the fallback for a client that drops References. */
export function threadRootId(references: string | null | undefined, inReplyTo: string | null | undefined): string | null {
  const first = (references ?? "").match(/<[^<>\s]+>/)?.[0] ?? (inReplyTo ?? "").match(/<[^<>\s]+>/)?.[0];
  return first ? first.toLowerCase() : null;
}
