// Studio days (Oct 19–22, 2026): every draft Claude wrote with the approval
// line goes out at the next send slot after Jayme deletes that line. Re-run
// after each drafting batch; it's idempotent.
//
//   npx tsx --env-file=.env.local scripts/studioQueue.ts [.draft-replies.json ...]
//
// Collects draft ids from (a) every earlier approval-gated send action and
// (b) the batch files given, then replaces the still-pending "Studio send"
// actions with one per future slot holding the full set. A draft that was
// already sent is a 404 ("gone"), and one still carrying the line is left
// alone, so repeating ids across slots is safe.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { SCHEDULED_ACTIONS_KEY, type ScheduledAction } from "../src/lib/scheduled/actions";
import { getAccessToken } from "../src/lib/gmail/client";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PREFIX = "DELETE THIS LINE TO APPROVE";
const LABEL = "Studio send";
// Drafts Jayme approved that must not go out as they stand (left in Drafts, just never queued).
// r-6195247996152572181: Jazz Gallery — says Summer played there; she hasn't (Oct 19).
const HOLD = new Set(["r-6195247996152572181"]);
// 11am, 2pm, 5pm Eastern on weekdays, from Oct 19 through Nov 6, 2026
// (extended past the studio days; EDT until Nov 1, then EST).
const SLOTS = (() => {
  const out: string[] = [];
  for (let d = new Date("2026-10-19T00:00:00Z"); d <= new Date("2026-11-06T00:00:00Z"); d = new Date(d.getTime() + 864e5)) {
    const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
    const off = d >= new Date("2026-11-01T00:00:00Z") ? 5 : 4;
    for (const h of [11, 14, 17]) out.push(`${d.toISOString().slice(0, 10)}T${String(h + off).padStart(2, "0")}:00:00Z`);
  }
  return out;
})();

(async () => {
  const { data } = await supabase.from("app_settings").select("value").eq("key", SCHEDULED_ACTIONS_KEY).maybeSingle();
  let actions: ScheduledAction[] = Array.isArray(data?.value) ? (data!.value as ScheduledAction[]) : [];
  const ids = new Set<string>();
  let pruneTo: Set<string> | null = null;
  for (const a of actions) if (a.type === "send_gmail_drafts" && a.params.account === "stone@jaymestone.com" && a.params.requireRemoved?.includes(PREFIX)) a.params.draftIds.forEach((x) => ids.add(x));
  // Also every draft in stone@ that carries the approval line — only Claude's
  // drafts have it — so a drafting run killed before writing its output file
  // (Oct 19, studio wifi) can't strand drafts.
  {
    const { data: acct } = await supabase.from("connected_accounts").select("id").eq("email_address", "stone@jaymestone.com").single();
    const tok = await getAccessToken(supabase, acct!.id);
    const g = async (p: string) => { for (let k = 0; k < 6; k++) { const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { headers: { Authorization: `Bearer ${tok}` } }); if (r.ok) return r.json(); await new Promise((x) => setTimeout(x, 3000 * (k + 1))); } return null; };
    const list = await g("drafts?maxResults=500&q=" + encodeURIComponent(`"${PREFIX}"`));
    for (const d of list?.drafts || []) ids.add(d.id);
    // Drop ids no longer in Drafts (sent or removed) so each slot only reads live ones.
    const live = new Set<string>(); let pt = "";
    do { const r = await g(`drafts?maxResults=500${pt ? `&pageToken=${pt}` : ""}`); for (const d of r?.drafts || []) live.add(d.id); pt = r?.nextPageToken || ""; } while (pt);
    pruneTo = live;
  }
  for (const f of process.argv.slice(2)) if (existsSync(f)) for (const o of JSON.parse(readFileSync(f, "utf8"))) if (o.draftId) ids.add(o.draftId);
  if (pruneTo) for (const id of [...ids]) if (!pruneTo.has(id)) ids.delete(id);
  for (const id of HOLD) ids.delete(id);
  const now = Date.now();
  actions = actions.filter((a) => !(a.label.startsWith(LABEL) && a.status === "pending"));
  for (const runAt of SLOTS.filter((s) => Date.parse(s) > now))
    actions.push({ id: randomUUID(), label: `${LABEL} ${runAt.slice(5, 16)}Z — approved drafts (${ids.size} tracked)`, runAt, status: "pending", createdAt: new Date().toISOString(), type: "send_gmail_drafts", params: { account: "stone@jaymestone.com", draftIds: [...ids], requireRemoved: PREFIX } });
  await supabase.from("app_settings").upsert({ key: SCHEDULED_ACTIONS_KEY, value: actions }, { onConflict: "key" });
  console.log(`${ids.size} drafts tracked; ${SLOTS.filter((s) => Date.parse(s) > now).length} send slots queued`);
})().catch((e) => { console.error(e); process.exit(1); });
