// Import a research JSON (venue candidates found by Claude) into Mailflow as
// contacts on a list. Nothing is enrolled in a campaign.
//
//   npx tsx --env-file=.env.local scripts/importResearch.ts <file.json> "<List name>" "<source tag>" [--sections "North America,International"] [--apply]
//
// Rows need a published email (first one found in `email`); form-only rows
// are reported, not imported. The booker's name is used only when the
// email's local part matches it (a named person's address); otherwise the
// first name is "Folks" (Jayme's rule for unknown names). Existing contacts
// are matched by email and skipped. Prints the new contact ids as JSON on
// the last line.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const [file, listName, source] = process.argv.slice(2);
const apply = process.argv.includes("--apply");
const sections = process.argv.includes("--sections") ? process.argv[process.argv.indexOf("--sections") + 1].split(",").map((x) => x.trim()) : null;
const COUNTRY: Record<string, string> = { usa: "United States", us: "United States", "u.s.": "United States", "united states of america": "United States", uk: "United Kingdom", england: "United Kingdom" };

(async () => {
  const rows: any[] = JSON.parse(readFileSync(file, "utf8")).filter((r: any) => !sections || sections.includes(r.section));
  let listId: string | null = null;
  const { data: list } = await supabase.from("lists").select("id").eq("name", listName).maybeSingle();
  if (list) listId = list.id;
  else if (apply) listId = (await supabase.from("lists").insert({ name: listName }).select("id").single()).data!.id;
  const added: string[] = [], noEmail: string[] = [], existing: string[] = [];
  for (const r of rows) {
    const email = String(r.email || "").match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
    if (!email) { noEmail.push(`${r.venue}${r.formUrl ? ` (form: ${r.formUrl})` : ""}`); continue; }
    const { data: ex } = await supabase.from("contacts").select("id").ilike("email", email);
    if (ex?.length) { existing.push(r.venue); continue; }
    const name = String(r.booker || "").split(/[;(,/]| or | and | & /)[0].trim().replace(/^(Dr|Rabbi|Cantor|Prof)\.?\s+/i, "");
    const [first, ...rest] = name.split(/\s+/);
    const local = email.split("@")[0].toLowerCase();
    const named = !!first && /^[A-Z][a-zà-ÿ]+$/.test(first) && (local.includes(first.toLowerCase()) || rest.some((l) => l.length > 2 && local.includes(l.toLowerCase())));
    const row = {
      first_name: named ? first : "Folks",
      last_name: named ? rest.join(" ") || null : null,
      email,
      venue: r.venue,
      venue_short: String(r.venue).replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim().slice(0, 40),
      venue_type: r.type ? String(r.type).slice(0, 60) : null,
      city: r.city || null,
      state: r.region || null,
      country: COUNTRY[String(r.country || "").toLowerCase()] || r.country || null,
      list_id: listId,
      source,
      notes: [r.booker && !named ? `Contact: ${r.booker}` : "", r.evidence || r.whyFit, r.season ? `Season: ${r.season}` : "", r.formUrl ? `Form: ${r.formUrl}` : "", r.source ? `Source: ${r.source}` : ""].filter(Boolean).join(" | ").slice(0, 1500),
    };
    if (!apply) { added.push(`${row.venue} <${email}> as ${row.first_name}`); continue; }
    const { data, error } = await supabase.from("contacts").insert(row).select("id").single();
    if (error) console.log("error", r.venue, error.message);
    else added.push(data.id);
  }
  console.log(`${apply ? "added" : "would add"} ${added.length}; already in Mailflow ${existing.length}; no email ${noEmail.length}`);
  if (noEmail.length) console.log("No email:", noEmail.join("; "));
  if (!apply) console.log(added.join("\n"));
  console.log(JSON.stringify(apply ? added : []));
})().catch((e) => { console.error(e); process.exit(1); });
