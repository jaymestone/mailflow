import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveResumeAt } from "./tick";
import type { ReplyCategory } from "./types";

// A reply only stops a contact's sequence if it actually matched them:
// send_engine_who_is_due excludes members by the existence of a matched
// inbound row. So whenever matching fails on a message that a human can
// plainly see belongs to a real contact, that contact keeps getting
// automated mail after they already answered.
//
// Matching fails for mundane reasons -- a reply sent from an alias, a
// colleague answering on someone's behalf, threading headers stripped by
// a corporate mail system, or (until 2026-09-22) a simple letter-case
// difference. Each individual cause is worth fixing, but there will
// always be a next one, so this exists as the standing safety net rather
// than another alert for a person to act on.
//
// Confirmed live 2026-09-22: 22 contacts sat in exactly this state, four
// of them genuine leads. Repairing them by hand took three mechanical
// rules and no judgement whatsoever -- which is precisely what belongs in
// a cron job rather than a human's inbox. Those three rules are what this
// applies, and they are deliberately the SAME actions reply/tick.ts
// already performs when matching succeeds, so a repaired message ends up
// indistinguishable from one that was never broken.
//
// What it will not touch: anything needing judgement. An "interested" or
// "follow_up" reply gets its match recorded (which stops the sequence, so
// nobody is emailed past their own reply) but is otherwise left alone for
// a human -- no suppression, no deletion, no assumptions about intent.

const LOOKBACK_DAYS = 14;

export type ReconcileResult = {
  dryRun: boolean;
  /** Unmatched messages examined. */
  examined: number;
  /** Messages whose sender resolved to a real contact still being sequenced. */
  repaired: number;
  /** Per-rule counts of what was actually applied. */
  matchedOnly: number;
  departedSuppressed: number;
  oooSnoozed: number;
  /** Contacts whose reply needs a person -- surfaced, never acted on. */
  needsHuman: { email: string; venue: string | null; category: string; subject: string | null }[];
  errors: { email: string; error: string }[];
};

/** Categories a human should answer. Their match is still recorded (that
 * is what stops the sequence), but nothing else is inferred from them. */
const HUMAN_CATEGORIES: ReplyCategory[] = ["interested", "follow_up", "unclear", "not_interested"];

export async function runReconcileTick(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean; lookbackDays?: number } = {},
): Promise<ReconcileResult> {
  const dryRun = opts.dryRun ?? false;
  const lookbackDays = opts.lookbackDays ?? LOOKBACK_DAYS;
  const result: ReconcileResult = {
    dryRun,
    examined: 0,
    repaired: 0,
    matchedOnly: 0,
    departedSuppressed: 0,
    oooSnoozed: 0,
    needsHuman: [],
    errors: [],
  };

  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: unmatched } = await supabase
    .from("inbound_messages")
    .select("id, from_email, subject, classification_category, message_type, ooo_return_date, received_at")
    .eq("match_method", "unmatched")
    .in("message_type", ["reply", "bounce"])
    .gte("received_at", cutoff)
    .order("received_at", { ascending: false })
    .limit(1000);

  const rows = unmatched ?? [];
  result.examined = rows.length;

  // Newest message per sender wins: one matched row is all the send engine
  // needs, and the most recent reply is the most current intent.
  const seen = new Set<string>();

  // Distinct senders, newest message first -- the resolution below runs
  // concurrently, so the ordering has to be fixed here rather than
  // emerging from the loop.
  const candidates: { sender: string; msg: (typeof rows)[number] }[] = [];
  for (const msg of rows) {
    const sender = msg.from_email?.toLowerCase();
    if (!sender || seen.has(sender)) continue;
    seen.add(sender);
    candidates.push({ sender, msg });
  }

  // Resolving each sender takes two queries, and most senders resolve to
  // nothing (they're strangers, mailer-daemons, or people who aren't
  // contacts) -- so the great majority of this work is lookups that find
  // no one. Done one at a time that's ~400 sequential round trips:
  // measured at 75s against real data, well past the ~30s ceiling
  // cron-job.org enforces, meaning the job would have been killed
  // mid-run every time. Resolving in parallel batches keeps the query
  // shapes identical while collapsing the wall time to a few seconds.
  const CONCURRENCY = 20;
  type Resolved = {
    msg: (typeof rows)[number];
    contact: { id: string; email: string; venue: string | null };
    activeMembers: { id: string; campaign_id: string }[];
  };
  const resolved: Resolved[] = [];

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async ({ sender, msg }): Promise<Resolved | null> => {
        try {
          // Case-insensitive, with ilike's wildcards escaped and the
          // result re-verified in JS -- same approach and reasoning as
          // matching.ts.
          const { data: found } = await supabase
            .from("contacts")
            .select("id, email, venue")
            .ilike("email", sender.replace(/([%_\\])/g, "\\$1"))
            .limit(5);
          const contact = (found ?? []).find((c) => c.email.toLowerCase() === sender);
          if (!contact) return null;

          const { data: activeMembers } = await supabase
            .from("campaign_members")
            .select("id, campaign_id")
            .eq("contact_id", contact.id)
            .eq("member_status", "active");
          if (!activeMembers || activeMembers.length === 0) return null;

          return { msg, contact, activeMembers };
        } catch (err) {
          result.errors.push({ email: sender, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      }),
    );
    for (const r of settled) if (r) resolved.push(r);
  }

  // Writes stay sequential: there are only ever a handful, and keeping
  // them ordered makes a partial run (killed mid-way) easy to reason
  // about -- whatever was repaired is simply repaired, and the rest is
  // picked up next time.
  for (const { msg, contact, activeMembers } of resolved) {
    const sender = contact.email.toLowerCase();
    try {
      const category = msg.classification_category as ReplyCategory | null;

      if (dryRun) {
        result.repaired++;
        if (category && HUMAN_CATEGORIES.includes(category)) {
          result.needsHuman.push({ email: contact.email, venue: contact.venue, category, subject: msg.subject });
        }
        continue;
      }

      // Rule 1, applied to every case: record the match. This alone is
      // what stops the sequence, so it runs before any category-specific
      // handling and regardless of what that handling decides.
      await supabase
        .from("inbound_messages")
        .update({
          matched_contact_id: contact.id,
          matched_campaign_id: activeMembers[0].campaign_id,
          match_method: "sender_email",
        })
        .eq("id", msg.id);
      result.repaired++;

      // A contact can have several unmatched messages, and duplicates of
      // one reply are common (the same Gmail message reaching two
      // connected accounts). Recording the match on each is always safe
      // and tidies the data, but ACTING on one is not: if this message is
      // older than a reply that already matched, its instruction is
      // stale. Applying it would let a weeks-old "I've left the
      // organisation" suppress a contact who has since replied with
      // interest. Equal timestamps are fine to skip too -- that's a
      // duplicate of a decision already applied.
      const { data: newerMatched } = await supabase
        .from("inbound_messages")
        .select("received_at")
        .eq("matched_contact_id", contact.id)
        .gte("received_at", msg.received_at)
        .limit(1)
        .maybeSingle();
      if (newerMatched) {
        result.matchedOnly++;
        continue;
      }

      if (category === "ooo_departed") {
        // Rule 2: the person is gone, which is true across every campaign
        // they're in -- mirrors tick.ts's own ooo_departed handling.
        // Deliberately does NOT delete the contact or queue replacement
        // research, unlike the live pipeline: those are irreversible, and
        // a reply that needed repairing is exactly the case where the
        // classification deserves a human's eyes before anything is
        // destroyed.
        const { data: already } = await supabase
          .from("suppression")
          .select("id")
          .ilike("email", contact.email)
          .maybeSingle();
        if (!already) {
          await supabase.from("suppression").insert({
            email: contact.email,
            reason: "departed",
            source_campaign_id: activeMembers[0].campaign_id,
            notes: "Departed reply that never matched; reconciled automatically.",
          });
        }
        await supabase
          .from("campaign_members")
          .update({ member_status: "paused" })
          .eq("contact_id", contact.id)
          .eq("member_status", "active");
        result.departedSuppressed++;
      } else if (category === "ooo_temporary") {
        // Rule 3: snooze every active sequence to their stated return
        // date -- same call tick.ts makes, including its fallback when the
        // date is missing, unparseable, or already past.
        await supabase
          .from("campaign_members")
          .update({ resume_at: resolveResumeAt(msg.ooo_return_date ?? null) })
          .eq("contact_id", contact.id)
          .eq("member_status", "active");
        result.oooSnoozed++;
      } else {
        // Everything else: the match is recorded (sequence stopped) and a
        // person decides what the reply actually warrants.
        result.matchedOnly++;
        if (category && HUMAN_CATEGORIES.includes(category)) {
          result.needsHuman.push({ email: contact.email, venue: contact.venue, category, subject: msg.subject });
        }
      }
    } catch (err) {
      result.errors.push({ email: sender, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
