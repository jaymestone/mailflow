import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReconcileTick } from "@/lib/reply/reconcile";
import { recordHeartbeat } from "@/lib/health/heartbeat";

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
  return NextResponse.json(result);
}
