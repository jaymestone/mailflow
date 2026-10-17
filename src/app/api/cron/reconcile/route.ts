import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReconcileTick } from "@/lib/reply/reconcile";
import { recordHeartbeat } from "@/lib/health/heartbeat";
import { runScheduledActions } from "@/lib/scheduled/actions";

// Pure database work -- no Gmail calls, no LLM calls -- so this is fast
// and nowhere near the 30s external-caller ceiling that constrains the
// reply and send ticks.
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const result = await runReconcileTick(admin);
  await recordHeartbeat(admin, "reconcile-tick", result);
  // One-off scheduled actions (src/lib/scheduled/actions.ts) ride on this
  // 15-minute tick rather than needing a cron job of their own. Kept separate
  // from the reconcile result so a failure here can't mask reconcile health.
  let scheduled: unknown;
  try {
    scheduled = await runScheduledActions(admin);
    await recordHeartbeat(admin, "scheduled-actions", scheduled);
  } catch (err) {
    scheduled = { error: err instanceof Error ? err.message : String(err) };
  }
  return NextResponse.json({ ...(result as object), scheduled });
}
