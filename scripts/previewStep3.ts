// Shows exactly which of step 3's three emails each contact would get,
// and what the rendered text looks like -- without sending anything.
//
// Runs the SAME resolveInterest and merge-field code the send engine runs,
// rather than a parallel implementation, so a preview that looks right is
// evidence the send will be right.

import { createClient } from "@supabase/supabase-js";
import { resolveInterest } from "../src/lib/clicks/interest";
import { resolveTemplate, findUnresolvedTokens } from "../src/lib/templates/resolve";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const CAMPAIGN = "US Venues Roster Announce";

async function pageAll<T>(table: string, select: string, f: (q: never) => unknown): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const q = f(supabase.from(table).select(select).range(from, from + size - 1) as never) as {
      data: T[] | null;
      error: { message: string } | null;
    };
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

async function main() {
  const showFull = process.argv.includes("--full");
  const { data: camp, error } = await supabase.from("campaigns").select("id").eq("name", CAMPAIGN).single();
  if (error) throw new Error(error.message);
  const campaignId = (camp as { id: string }).id;

  const { data: templates } = await supabase
    .from("campaign_templates")
    .select("variant, body")
    .eq("campaign_id", campaignId)
    .eq("step_number", 3);
  if (!templates || templates.length === 0) {
    console.log("No step 3 templates yet — run seedStep3.ts first.");
    return;
  }
  const bodyFor = new Map((templates as { variant: string; body: string }[]).map((t) => [t.variant, t.body]));

  // Everyone who will still be in the sequence when step 3 comes due.
  const members = await pageAll<{ contact_id: string }>("campaign_members", "contact_id", (q) =>
    (q as never as { eq: (a: string, b: unknown) => unknown }).eq("campaign_id", campaignId),
  );
  const activeIds = [...new Set(members.map((m) => m.contact_id))];

  const interest = await resolveInterest(supabase, campaignId, activeIds);

  const contacts: { id: string; first_name: string | null; venue: string | null; venue_short: string | null }[] = [];
  for (let i = 0; i < activeIds.length; i += 300) {
    const { data } = await supabase
      .from("contacts")
      .select("id, first_name, venue, venue_short")
      .in("id", activeIds.slice(i, i + 300));
    contacts.push(...((data ?? []) as typeof contacts));
  }

  const counts: Record<string, number> = { clicked_focused: 0, clicked_broad: 0, no_click: 0 };
  const samples: Record<string, string[]> = { clicked_focused: [], clicked_broad: [], no_click: [] };
  let unresolved = 0;

  for (const contact of contacts) {
    const info = interest.get(contact.id);
    if (!info) continue;
    counts[info.bucket]++;

    const body = bodyFor.get(info.bucket) ?? bodyFor.get("default")!;
    const rendered = resolveTemplate(body, { ...contact, clicked_artists: info.artists });
    if (findUnresolvedTokens(rendered).length > 0) unresolved++;

    if (samples[info.bucket].length < (showFull ? 3 : 2)) {
      samples[info.bucket].push(rendered);
    }
  }

  console.log(`STEP 3 PREVIEW — ${CAMPAIGN}\n`);
  console.log(`  named artists (1-3 clicked):  ${counts.clicked_focused}`);
  console.log(`  whole-roster (4+ clicked):    ${counts.clicked_broad}`);
  console.log(`  no genuine click:             ${counts.no_click}`);
  console.log(`  would be SKIPPED (unresolved tokens): ${unresolved}`);

  for (const variant of ["clicked_focused", "clicked_broad", "no_click"]) {
    console.log(`\n${"=".repeat(72)}\n${variant.toUpperCase()}  (${counts[variant]} contacts)\n${"=".repeat(72)}`);
    for (const s of samples[variant]) {
      console.log(showFull ? s : s.split("\n").slice(0, 5).join("\n"));
      console.log("  ---");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  });
