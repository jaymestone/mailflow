// Tour push: enrol the venues Jayme ticked on a push tracker tab into that
// push's (draft) Mailflow campaign. Dry run unless --apply; --activate also
// flips the campaign to active so the send engine starts on it.
//
//   npx tsx --env-file=.env.local scripts/tourEnroll.ts "<tab name>" <campaignId> [--apply] [--activate]
//
// The tracker's campaign rows carry the contact id in hidden column H and a
// tick box in A. Right before enrolling, each contact is re-checked: anyone who
// has since replied (to anything), been suppressed, or joined another active
// sequence, or has a "DO NOT PITCH (<this campaign's name>)" line in its notes, is skipped and reported, so a venue never gets the cold pitch
// after starting a conversation.
import { createClient } from "@supabase/supabase-js";
import { batchGet } from "../src/lib/workbook/sheets";
import { MASTER_SPREADSHEET_ID, SHEET_ROSTER } from "../src/lib/workbook/roster";
import { readBookings, sameVenue } from "../src/lib/workbook/plan";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const [tab, campaignId, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply"), activate = flags.includes("--activate");

(async () => {
  if (!tab || !campaignId) throw new Error("usage: tourEnroll.ts <tab> <campaignId> [--apply] [--activate]");
  const [grid] = await batchGet(MASTER_SPREADSHEET_ID, [`'${tab}'!A1:H2000`]);
  const ticked = (grid || []).filter((r: any[]) => (r[0] === true || r[0] === "TRUE") && /^[0-9a-f-]{36}$/.test(String(r[7] || "")));
  console.log(`${ticked.length} ticked rows on "${tab}"`);

  const ids = ticked.map((r: any[]) => String(r[7]));
  const { data: contacts } = await supabase.from("contacts").select("id,email,first_name,venue,notes").in("id", ids);
  const { data: sup } = await supabase.from("suppression").select("email");
  const suppressed = new Set((sup || []).map((x) => x.email.toLowerCase()));
  const { data: replies } = await supabase.from("inbound_messages").select("matched_contact_id,classification_category").in("matched_contact_id", ids);
  const replied = new Set((replies || []).filter((x) => !/bounce|ooo|auto/.test(x.classification_category || "")).map((x) => x.matched_contact_id));
  const { data: members } = await supabase.from("campaign_members").select("contact_id,campaign_id,member_status,current_step").in("contact_id", ids);
  const { data: tpl } = await supabase.from("campaign_templates").select("campaign_id,step_number");
  const maxStep: Record<string, number> = {};
  for (const t of tpl || []) maxStep[t.campaign_id] = Math.max(maxStep[t.campaign_id] || 0, t.step_number);
  const { data: camps } = await supabase.from("campaigns").select("id,status,name");
  const thisName = (camps || []).find((c) => c.id === campaignId)?.name || campaignId;
  // A hold is scoped to one campaign, so the contact stays available for others.
  const held = (notes: string | null) => (notes || "").split("\n").some((l) => /^DO NOT PITCH \(([^)]*)\)/i.test(l) && l.includes(`(${thisName})`));
  const active = new Set((camps || []).filter((c) => c.status === "active").map((c) => c.id));

  // Organisation-level guard: a colleague at the same domain (or the same
  // generic address) already in an active sequence elsewhere means this venue
  // is being pitched already — e.g. Festival International had two contacts
  // mid-"US Festivals Pitch" when a third was found by research.
  const GENERIC = /@(gmail|yahoo|hotmail|aol|outlook|icloud|comcast|me|msn|live|mac|earthlink|sbcglobal|att|bellsouth)\./i;
  const orgOf = (e: string) => (GENERIC.test(e) ? e.toLowerCase() : e.split("@")[1]?.toLowerCase());
  const orgs = [...new Set((contacts || []).map((c) => orgOf(c.email)).filter(Boolean))] as string[];
  const busyOrg = new Map<string, string>();
  for (const o of orgs) {
    const { data: colleagues } = await supabase.from("contacts").select("id").ilike("email", o.includes("@") ? o : `%@${o}`);
    const others = (colleagues || []).map((x) => x.id);
    if (!others.length) continue;
    const { data: mem } = await supabase.from("campaign_members").select("contact_id,campaign_id,member_status,current_step").in("contact_id", others);
    const hit = (mem || []).find((m) => m.campaign_id !== campaignId && m.member_status === "active" && active.has(m.campaign_id) && m.current_step < (maxStep[m.campaign_id] || 0));
    if (hit) busyOrg.set(o, (camps || []).find((c) => c.id === hit.campaign_id)?.name || hit.campaign_id);
  }

  // A venue this artist has played in the last 18 months (or is booked at)
  // never gets the cold "I represent..." pitch. Amanda had played La Grua
  // Center in June 2026 and got the July 2027 Northeast cold pitch in
  // November; La Grua waits 18 months before rebooking anyone (Nov 10).
  const artist = SHEET_ROSTER.find((a) => thisName.includes(a.replace(/^The /, "")));
  const cutoff = new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10);
  const [master] = await batchGet(MASTER_SPREADSHEET_ID, ["Master!A2:H3000"]);
  const played = readBookings(master).filter((b) => b.artist === artist && b.range && b.range[1] >= cutoff);
  const { data: shorts } = await supabase.from("contacts").select("id,venue_short").in("id", ids);
  const shortOf = new Map((shorts || []).map((x) => [x.id, x.venue_short]));
  const playedAt = (c: { id: string; venue: string | null }) => played.find((b) => sameVenue(b.venue, c.venue) || (shortOf.get(c.id) && sameVenue(b.venue, shortOf.get(c.id))));

  const toAdd: string[] = [];
  for (const c of contacts || []) {
    const mine = (members || []).find((m) => m.contact_id === c.id && m.campaign_id === campaignId);
    const midOther = (members || []).some((m) => m.contact_id === c.id && m.campaign_id !== campaignId && m.member_status === "active" && active.has(m.campaign_id) && m.current_step < (maxStep[m.campaign_id] || 0));
    const why = /NO CAMPAIGNS/.test(c.notes || "") ? "marked NO CAMPAIGNS" : held(c.notes) ? `on hold for "${thisName}"` : mine ? "already enrolled" : suppressed.has(c.email.toLowerCase()) ? "suppressed" : replied.has(c.id) ? "has replied since the tracker was built — reply in the thread instead" : midOther ? "mid-sequence in another campaign" : busyOrg.has(orgOf(c.email)) ? `a colleague is mid-sequence in "${busyOrg.get(orgOf(c.email))}"` : playedAt(c) ? `${artist} played/is booked here (${playedAt(c)!.dateText}) — no cold pitch; check their rebooking gap, pitch other artists warmly` : "";
    if (why) console.log(`SKIP ${c.venue} <${c.email}>: ${why}`);
    else toAdd.push(c.id);
  }
  console.log(`${toAdd.length} to enrol${apply ? "" : " (dry run — add --apply)"}`);
  if (!apply || !toAdd.length) return;
  const { error } = await supabase.from("campaign_members").insert(toAdd.map((contact_id) => ({ campaign_id: campaignId, contact_id, member_status: "active", current_step: 0 })));
  if (error) throw error;
  console.log(`enrolled ${toAdd.length}`);
  if (activate) {
    await supabase.from("campaigns").update({ status: "active" }).eq("id", campaignId);
    console.log("campaign is now active; the send engine will pace it out");
  }
})().catch((e) => { console.error(e); process.exit(1); });
