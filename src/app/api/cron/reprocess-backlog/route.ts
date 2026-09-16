import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reprocessStuckMessages } from "@/lib/reply/reprocess";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 30;

// Daily unattended safety net for the checkpoint-skip failure mode fixed
// 2026-09-16 (see reply/tick.ts) -- the fix should mean this finds nothing
// on an ordinary day, but a small, cheap, bounded sweep costs little and
// catches any straggler this fix (or a future one just like it) misses.
// windowDays is small (this only needs to look back one day past the
// previous run) and maxMessages keeps a real find bounded so this can
// never balloon into the exact kind of long-running tick that caused the
// original bug's underlying timeout pressure -- a truncated result here is
// itself surfaced by the health-alert-tick's unlabeled-backlog signal on
// the next reply-poll-tick, rather than this cron silently trying to
// absorb an unexpectedly large backlog on its own.
const WINDOW_DAYS = 2;
const MAX_MESSAGES = 50;

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const result = await reprocessStuckMessages(admin, { dryRun: false, windowDays: WINDOW_DAYS, maxMessages: MAX_MESSAGES });
  await recordHeartbeat(admin, "reprocess-backlog-tick", result);
  return NextResponse.json(result);
}
