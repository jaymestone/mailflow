// Hard facts about a venue, kept in the contact's notes (Jayme, 2026-11-02):
// "They shouldn't be conversation summaries. They should be hard facts about
// the venue, like capacity, rentals only, summer only, fee ranges, or any
// other important details like festival dates, classical only, etc."
//
// The summariser proposes facts from each thread; this merges them into a
// single block at the end of the notes, leaving everything Jayme (or anyone)
// wrote above it untouched.

export const FACTS_HEADER = "Venue facts:";
const MAX_FACTS = 8;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();

/** Merge new facts into notes. Existing facts are kept; a new fact that says
 * the same thing (same words, ignoring punctuation and case) is skipped. */
export function mergeVenueFacts(notes: string | null | undefined, facts: string[]): string | null {
  const text = notes ?? "";
  const at = text.indexOf(FACTS_HEADER);
  const before = (at >= 0 ? text.slice(0, at) : text).trimEnd();
  const existing = at >= 0
    ? text.slice(at + FACTS_HEADER.length).split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean)
    : [];
  const seen = new Set(existing.map(norm));
  const added = facts
    .map((f) => f.replace(/\s+/g, " ").trim())
    .filter((f) => f.length > 3 && f.length <= 140)
    .filter((f) => { const k = norm(f); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!added.length) return notes ?? null;
  const all = [...existing, ...added].slice(-MAX_FACTS);
  const block = `${FACTS_HEADER}\n${all.map((f) => `- ${f}`).join("\n")}`;
  return before ? `${before}\n\n${block}` : block;
}

/** Replace the whole facts block (used by the one-off backfill). */
export function replaceVenueFacts(notes: string | null | undefined, facts: string[]): string | null {
  const text = notes ?? "";
  const at = text.indexOf(FACTS_HEADER);
  const before = (at >= 0 ? text.slice(0, at) : text).trimEnd();
  return mergeVenueFacts(before || null, facts);
}
