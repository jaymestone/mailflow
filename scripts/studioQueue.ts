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

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PREFIX = "DELETE THIS LINE TO APPROVE";
const LABEL = "Studio send";
// 11am, 2pm, 5pm Eastern (EDT = UTC-4), Mon Oct 19 – Wed Oct 21, plus Thu 9am.
const SLOTS = ["19", "20", "21"].flatMap((d) => [15, 18, 21].map((h) => `2026-10-${d}T${h}:00:00Z`)).concat(["2026-10-22T13:00:00Z"]);

(async () => {
  const { data } = await supabase.from("app_settings").select("value").eq("key", SCHEDULED_ACTIONS_KEY).maybeSingle();
  let actions: ScheduledAction[] = Array.isArray(data?.value) ? (data!.value as ScheduledAction[]) : [];
  const ids = new Set<string>();
  for (const a of actions) if (a.type === "send_gmail_drafts" && a.params.account === "stone@jaymestone.com" && a.params.requireRemoved?.includes(PREFIX)) a.params.draftIds.forEach((x) => ids.add(x));
  for (const f of process.argv.slice(2)) if (existsSync(f)) for (const o of JSON.parse(readFileSync(f, "utf8"))) if (o.draftId) ids.add(o.draftId);
  const now = Date.now();
  actions = actions.filter((a) => !(a.label.startsWith(LABEL) && a.status === "pending"));
  for (const runAt of SLOTS.filter((s) => Date.parse(s) > now))
    actions.push({ id: randomUUID(), label: `${LABEL} ${runAt.slice(5, 16)}Z — approved drafts (${ids.size} tracked)`, runAt, status: "pending", createdAt: new Date().toISOString(), type: "send_gmail_drafts", params: { account: "stone@jaymestone.com", draftIds: [...ids], requireRemoved: PREFIX } });
  await supabase.from("app_settings").upsert({ key: SCHEDULED_ACTIONS_KEY, value: actions }, { onConflict: "key" });
  console.log(`${ids.size} drafts tracked; ${SLOTS.filter((s) => Date.parse(s) > now).length} send slots queued`);
})().catch((e) => { console.error(e); process.exit(1); });
