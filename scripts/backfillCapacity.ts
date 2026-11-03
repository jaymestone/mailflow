// Fill contacts.capacity from the "Venue facts:" block in notes (e.g. "120 cap",
// "Capacity 300", "~100 seats"). Only fills empty capacity.
//   npx tsx --env-file=.env.local scripts/backfillCapacity.ts [--apply]
import { createClient } from "@supabase/supabase-js";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const apply = process.argv.includes("--apply");
/** Every stated room capacity in the facts: { max, min } (min only when there are several rooms). */
export function capacityFrom(facts: string): { max: number; min: number | null } | null {
  // One fact line = one space (seated / standing / SRO figures are setups of the
  // same room, so a line counts as its largest figure) -- unless the line says it
  // spans several venues or halls ("Venues range 450-2600 cap"), or names a side
  // room ("125 cap small room"), which only informs the smallest.
  const spaces: number[] = []; const sideRooms: number[] = [];
  for (const line of facts.split("\n")) {
    if (/must sell|planned|budget|\$/i.test(line)) continue;
    const re = /(\d{1,3}(?:,\d{3})+|\d{2,5})(?:\s*[–-]\s*(\d{1,3}(?:,\d{3})+|\d{2,5}))?\s*-?\s*(?:cap\b|capacity|seats?\b|seated|SRO|standing)|(?:capacity|cap)\s*(?:of\s*)?~?(\d{1,3}(?:,\d{3})+|\d{2,5})|max(?:imum)?\s*(\d{2,5})/gi;
    const nums: number[] = []; let m: RegExpExecArray | null;
    while ((m = re.exec(line))) for (const g of [m[1], m[2], m[3], m[4]]) if (g) { const n = parseInt(g.replace(/,/g, ""), 10); if (n >= 20 && n <= 60000) nums.push(n); }
    if (!nums.length) continue;
    if (/small(est)? room|black ?box|side room|studio theat/i.test(line)) sideRooms.push(Math.min(...nums));
    else if (/venues|rooms|halls|spaces/i.test(line) && nums.length > 1) spaces.push(...nums);
    else spaces.push(Math.max(...nums));
  }
  if (!spaces.length) return null; // side room alone doesn't tell us the main capacity
  const max = Math.max(...spaces), min = Math.min(...spaces, ...sideRooms);
  return { max, min: min < max ? min : null };
}
(async () => {
  const rows: any[] = []; let from = 0;
  for (;;) { const { data } = await s.from("contacts").select("id,venue,notes,capacity,capacity_min").ilike("notes", "%Venue facts:%").range(from, from + 999); if (!data?.length) break; rows.push(...data); from += 1000; }
  let n = 0;
  for (const r of rows) {
    const facts = r.notes.slice(r.notes.indexOf("Venue facts:"));
    const cap = capacityFrom(facts);
    if (!cap) continue;
    const patch: Record<string, number> = {};
    if (!r.capacity || r.capacity < cap.max) patch.capacity = cap.max;
    if (cap.min && !r.capacity_min) patch.capacity_min = cap.min;
    if (!Object.keys(patch).length) continue;
    n++;
    if (!apply) console.log(`${r.venue} → ${JSON.stringify(patch)}   (was ${r.capacity ?? "-"}/${r.capacity_min ?? "-"})`);
    else await s.from("contacts").update(patch).eq("id", r.id);
  }
  console.log(`${apply ? "filled" : "would fill"} ${n} of ${rows.length} contacts with venue facts`);
})();
