// Fill contacts.capacity from the "Venue facts:" block in notes (e.g. "120 cap",
// "Capacity 300", "~100 seats"). Only fills empty capacity.
//   npx tsx --env-file=.env.local scripts/backfillCapacity.ts [--apply]
import { createClient } from "@supabase/supabase-js";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const apply = process.argv.includes("--apply");
export function capacityFrom(facts: string): number | null {
  for (const line of facts.split("\n")) {
    // Not a single, current capacity: ranges across rooms, sales targets, planned halls, side rooms.
    if (/\d\s*[–-]\s*[\d,]+\s*(cap|seat)|must sell|planned|small(est)? room|range/i.test(line)) continue;
    const re = /(?:~|about )?(\d{1,3}(?:,\d{3})+|\d{2,5})\s*-?\s*(?:cap\b|capacity|seats?\b|seated)|(?:capacity|cap)\s*(?:of\s*)?~?(\d{1,3}(?:,\d{3})+|\d{2,5})|max(?:imum)?\s*(\d{2,5})/gi;
    let m: RegExpExecArray | null; const hits: { at: number; n: number }[] = [];
    while ((m = re.exec(line))) { const n = parseInt((m[1] || m[2] || m[3]).replace(/,/g, ""), 10); if (n >= 20 && n <= 60000) hits.push({ at: m.index, n }); }
    if (hits.length) return hits.sort((a, b) => a.at - b.at)[0].n;
  }
  return null;
}
(async () => {
  const rows: any[] = []; let from = 0;
  for (;;) { const { data } = await s.from("contacts").select("id,venue,notes,capacity").ilike("notes", "%Venue facts:%").is("capacity", null).range(from, from + 999); if (!data?.length) break; rows.push(...data); from += 1000; }
  let n = 0;
  for (const r of rows) {
    const facts = r.notes.slice(r.notes.indexOf("Venue facts:"));
    const cap = capacityFrom(facts);
    if (!cap) continue;
    n++;
    if (!apply) console.log(`${r.venue} → ${cap}   [${(facts.split("\n").find((l: string) => l.includes(String(cap)) || /cap|seat/i.test(l)) || "").trim()}]`);
    else await s.from("contacts").update({ capacity: cap }).eq("id", r.id);
  }
  console.log(`${apply ? "filled" : "would fill"} ${n} of ${rows.length} contacts with venue facts`);
})();
