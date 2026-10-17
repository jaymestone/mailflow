// Add, list or cancel one-off scheduled actions (run by the 15-minute
// reconcile tick — see src/lib/scheduled/actions.ts).
//
//   npx tsx --env-file=.env.local scripts/schedule.ts list
//   npx tsx --env-file=.env.local scripts/schedule.ts add <actions.json>
//   npx tsx --env-file=.env.local scripts/schedule.ts cancel <id>
//
// actions.json: [{ "label": "...", "runAt": "2026-10-19T15:00:00Z", "type": "send_gmail_drafts" | "activate_campaign" | "unpause_members", "params": {...} }]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { SCHEDULED_ACTIONS_KEY, type ScheduledAction } from "../src/lib/scheduled/actions";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const [cmd, arg] = process.argv.slice(2);

(async () => {
  const { data } = await supabase.from("app_settings").select("value").eq("key", SCHEDULED_ACTIONS_KEY).maybeSingle();
  let actions: ScheduledAction[] = Array.isArray(data?.value) ? (data!.value as ScheduledAction[]) : [];
  if (cmd === "add") {
    const add = JSON.parse(readFileSync(arg, "utf8")).map((a: any) => ({ ...a, id: randomUUID(), status: "pending", createdAt: new Date().toISOString() }));
    actions = actions.concat(add);
  } else if (cmd === "cancel") {
    actions = actions.filter((a) => a.id !== arg);
  } else if (cmd !== "list") throw new Error("usage: list | add <file> | cancel <id>");
  if (cmd !== "list") await supabase.from("app_settings").upsert({ key: SCHEDULED_ACTIONS_KEY, value: actions }, { onConflict: "key" });
  for (const a of actions) console.log(`${a.status.padEnd(7)} ${a.runAt}  ${a.type.padEnd(18)} ${a.label}  (${a.id})${a.result ? "  → " + JSON.stringify(a.result) : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
