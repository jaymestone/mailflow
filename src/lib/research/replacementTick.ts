import type { SupabaseClient } from "@supabase/supabase-js";
import { findReplacementContact } from "./findReplacement";

export type ReplacementTickResult = {
  processed: number;
  replaced: number;
  noReplacementFound: number;
  skipped: number;
  errors: { id: string; error: string }[];
};

// Each item does a real Claude + web-search lookup (can take several
// seconds per web_search round), and this runs inside a 60s serverless
// function (Vercel Hobby plan's ceiling) — so one run only clears a bounded
// slice of the queue. Any leftover pending rows just carry over to next
// week's run; nothing is lost, the queue self-drains over time.
const BATCH_SIZE = 8;

export async function runReplacementResearchTick(supabase: SupabaseClient): Promise<ReplacementTickResult> {
  const result: ReplacementTickResult = {
    processed: 0,
    replaced: 0,
    noReplacementFound: 0,
    skipped: 0,
    errors: [],
  };

  const { data: pending } = await supabase
    .from("replacement_queue")
    .select("id, venue, venue_type, city, state, country, list_id, removed_contact_email, removed_reason")
    .eq("status", "pending")
    .order("removed_at", { ascending: true })
    .limit(BATCH_SIZE);

  for (const item of pending ?? []) {
    result.processed++;
    try {
      if (!item.venue) {
        // Nothing to research without a venue name to search for.
        await supabase
          .from("replacement_queue")
          .update({
            status: "skipped",
            researched_at: new Date().toISOString(),
            notes: "No venue name recorded on the removed contact — nothing to research.",
          })
          .eq("id", item.id);
        result.skipped++;
        continue;
      }

      const found = await findReplacementContact(item);

      if (!found.found) {
        await supabase
          .from("replacement_queue")
          .update({ status: "no_replacement_found", researched_at: new Date().toISOString(), notes: found.note })
          .eq("id", item.id);
        result.noReplacementFound++;
        continue;
      }

      // Research runs blind to the current DB — always re-check before
      // inserting, so a found address that's already a contact or was
      // already suppressed for an unrelated reason doesn't get duplicated
      // or silently re-added past a prior suppression decision.
      const [{ data: existingContact }, { data: suppressed }] = await Promise.all([
        supabase.from("contacts").select("id").ilike("email", found.email).maybeSingle(),
        supabase.from("suppression").select("id").ilike("email", found.email).maybeSingle(),
      ]);

      if (existingContact || suppressed) {
        await supabase
          .from("replacement_queue")
          .update({
            status: "no_replacement_found",
            researched_at: new Date().toISOString(),
            notes: `Found ${found.email}, but it's already ${existingContact ? "in the contact list" : "on the suppression list"}.`,
          })
          .eq("id", item.id);
        result.noReplacementFound++;
        continue;
      }

      const note = found.usedGenericFallback
        ? `${found.note} (generic inbox — used as last resort, no named alternative found)`
        : found.note;

      await supabase.from("contacts").insert({
        first_name: found.first_name,
        last_name: found.last_name,
        email: found.email,
        venue: found.venue ?? item.venue,
        venue_type: found.venue_type ?? item.venue_type,
        city: found.city ?? item.city,
        state: found.state ?? item.state,
        country: found.country ?? item.country,
        website: found.website,
        list_id: item.list_id,
        source: `Auto-replacement for ${item.removed_contact_email} (${item.removed_reason})`,
        notes: note,
      });

      await supabase
        .from("replacement_queue")
        .update({ status: "replaced", researched_at: new Date().toISOString(), notes: note })
        .eq("id", item.id);
      result.replaced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.errors.push({ id: item.id, error: message });
      // Left as 'pending' — a transient failure (e.g. the API hiccups on
      // this item) shouldn't be treated as "no replacement found"; next
      // week's run picks it up and tries again.
    }
  }

  return result;
}
