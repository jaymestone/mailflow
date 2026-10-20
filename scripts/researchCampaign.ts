// Build a DRAFT campaign from researched contacts (see importResearch.ts).
//   npx tsx --env-file=.env.local scripts/researchCampaign.ts <config.json>
// config: { name, artist, source, countries?, exclude? (emails), excludeVenues? (regex), alsoEmails?, notes, steps: [{days, subject, body}] }
// Skips suppressed contacts and anyone active in a live campaign. Nothing sends until Jayme activates it.
import { createClient } from "@supabase/supabase-js";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const SIG = "\n\nKindly,\n\nJayme Stone\n303.495.0989\n[jaymestone.com](https://www.jaymestone.com/agency)\ninstigator / integrator";
// args: JSON config file
(async () => {
  const cfg = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
  let ids: string[] = [];
  if (cfg.source) {
    const { data } = await s.from("contacts").select("id,email,country,venue").eq("source", cfg.source);
    const xv = cfg.excludeVenues ? new RegExp(cfg.excludeVenues, "i") : null;
    ids = (data || []).filter((c) => (!cfg.countries || cfg.countries.includes(c.country)) && !(cfg.exclude || []).includes(c.email.toLowerCase()) && !(xv && xv.test(c.venue))).map((c) => c.id);
  }
  for (const e of cfg.alsoEmails || []) { const { data } = await s.from("contacts").select("id").ilike("email", e); if (data?.[0]) ids.push(data[0].id); }
  // Skip anyone suppressed or already active in another live campaign.
  const { data: cs } = await s.from("contacts").select("id,email").in("id", ids);
  const { data: sup } = await s.from("suppression").select("email").in("email", (cs || []).map((c) => c.email.toLowerCase()));
  const supd = new Set((sup || []).map((x) => x.email));
  const { data: mem } = await s.from("campaign_members").select("contact_id,member_status,campaigns(status)").in("contact_id", ids);
  const busy = new Set((mem || []).filter((m: any) => m.member_status === "active" && m.campaigns?.status === "active").map((m) => m.contact_id));
  ids = [...new Set(ids)].filter((id) => !busy.has(id) && !supd.has((cs || []).find((c) => c.id === id)?.email.toLowerCase() || ""));
  const { data: c, error } = await s.from("campaigns").insert({ name: cfg.name, artists: cfg.artist, status: "draft", notes: cfg.notes }).select().single();
  if (error) throw error;
  await s.from("campaign_templates").insert(cfg.steps.map((st: any, i: number) => ({ campaign_id: c.id, step_number: i + 1, days_after_previous: st.days, variant: "default", subject: st.subject || "", body: st.body + SIG })));
  const { error: e2 } = await s.from("campaign_members").insert(ids.map((contact_id) => ({ campaign_id: c.id, contact_id, member_status: "active", current_step: 0 })));
  console.log(e2?.message || `${cfg.name}: draft ${c.id}, ${ids.length} members (skipped ${busy.size} busy, ${supd.size} suppressed)`);
})();
