import type { SupabaseClient } from "@supabase/supabase-js";
import { findReplacementContact } from "./findReplacement";

export type ReplacementTickResult = {
  processed: number;
  replaced: number;
  reenrolled: number;
  noReplacementFound: number;
  skipped: number;
  errors: { id: string; error: string }[];
};

// Each item does a real Claude + web-search lookup, processed sequentially,
// and this route only gets Vercel's 60s maxDuration (cron-job.org's own
// client timeout, ~30s, is even shorter). Confirmed in production that
// batch size 2 alone hit Vercel's hard 60s ceiling — a single research
// lookup can legitimately take a real chunk of that budget. One item per
// run gives it the whole window instead of splitting it; any leftover
// pending rows just carry over to the next day's run — nothing is lost,
// the queue self-drains over time regardless of batch size.
const BATCH_SIZE = 1;

// With only one item tried per run, the query always resurfaces the same
// oldest pending row until it resolves — a deterministically slow search
// (not just a one-off network blip) would otherwise block every other
// queued venue behind it forever. Give up after a few tries and let the
// rest of the queue through.
const MAX_RESEARCH_ATTEMPTS = 3;

export async function runReplacementResearchTick(supabase: SupabaseClient): Promise<ReplacementTickResult> {
  const result: ReplacementTickResult = {
    processed: 0,
    replaced: 0,
    reenrolled: 0,
    noReplacementFound: 0,
    skipped: 0,
    errors: [],
  };

  const { data: pending } = await supabase
    .from("replacement_queue")
    .select(
      "id, venue, venue_type, city, state, country, list_id, removed_contact_email, removed_reason, campaign_ids, research_attempts",
    )
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

      const genericNote = found.usedGenericFallback
        ? `${found.note} (generic inbox — used as last resort, no named alternative found)`
        : found.note;

      const { data: inserted, error: insertError } = await supabase
        .from("contacts")
        .insert({
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
          notes: genericNote,
        })
        .select("id")
        .single();

      if (insertError || !inserted) throw new Error(insertError?.message ?? "Contact insert returned no row");

      // Re-enroll into whatever campaigns the deleted contact was actively
      // in — starting fresh at step 1 (campaign_members defaults to
      // current_step 0), since this contact has never received any of the
      // sequence. A campaign that's since been paused or completed is left
      // alone rather than resumed on its behalf.
      const campaignIds: string[] = item.campaign_ids ?? [];
      let enrolledNames: string[] = [];
      let skippedNames: string[] = [];
      if (campaignIds.length > 0) {
        const { data: campaigns } = await supabase.from("campaigns").select("id, name, status").in("id", campaignIds);
        const active = (campaigns ?? []).filter((c) => c.status === "active");
        const inactive = (campaigns ?? []).filter((c) => c.status !== "active");
        if (active.length > 0) {
          const { error: enrollError } = await supabase
            .from("campaign_members")
            .insert(active.map((c) => ({ campaign_id: c.id, contact_id: inserted.id })));
          if (!enrollError) {
            enrolledNames = active.map((c) => c.name);
            result.reenrolled++;
          }
        }
        skippedNames = inactive.map((c) => c.name);
      }

      const enrollNote =
        enrolledNames.length > 0 ? ` Re-enrolled in: ${enrolledNames.join(", ")}.` : "";
      const skipNote =
        skippedNames.length > 0 ? ` Not re-enrolled (no longer active): ${skippedNames.join(", ")}.` : "";
      const note = `${genericNote}${enrollNote}${skipNote}`;

      await supabase
        .from("replacement_queue")
        .update({ status: "replaced", researched_at: new Date().toISOString(), notes: note })
        .eq("id", item.id);
      result.replaced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.errors.push({ id: item.id, error: message });

      const attempts = (item.research_attempts ?? 0) + 1;
      if (attempts >= MAX_RESEARCH_ATTEMPTS) {
        // Deterministically stuck (e.g. a search that reliably needs more
        // time than the per-call timeout allows) — give up so it stops
        // blocking every other queued venue behind it, and flag it for a
        // manual look instead of retrying forever.
        await supabase
          .from("replacement_queue")
          .update({
            status: "no_replacement_found",
            research_attempts: attempts,
            researched_at: new Date().toISOString(),
            notes: `Research failed ${attempts} times in a row (${message}) — needs a manual look.`,
          })
          .eq("id", item.id);
      } else {
        // Left as 'pending' — a transient failure (e.g. the API hiccups on
        // this item) shouldn't be treated as "no replacement found" yet;
        // next run picks it up and tries again.
        await supabase.from("replacement_queue").update({ research_attempts: attempts }).eq("id", item.id);
      }
    }
  }

  return result;
}
