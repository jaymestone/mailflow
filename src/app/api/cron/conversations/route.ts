import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runConversationBuildTick } from "@/lib/conversations/buildTick";
import { runConversationSummarizeTick } from "@/lib/conversations/summarizeTick";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 60;

/** Rebuilds the booking board, then summarises a few of the threads that
 * moved.
 *
 * Both halves run in one tick deliberately: the build is cheap and must
 * happen first (it is what discovers that a thread moved), and the
 * summarise pass is strictly bounded by its own wall-clock deadline, so
 * the pair still fits inside cron-job.org's hard 30-second ceiling.
 *
 * startedAt is taken here, not inside the summarise pass, so that deadline
 * covers the build's time too -- otherwise a slow build plus a full
 * summarise batch could exceed 30s between them and have the whole
 * function killed mid-write.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();

  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const build = await runConversationBuildTick(admin);
  const summarize = await runConversationSummarizeTick(admin, { startedAt });

  const result = { build, summarize, elapsedMs: Date.now() - startedAt };
  await recordHeartbeat(admin, "conversations-tick", result);
  return NextResponse.json(result);
}
