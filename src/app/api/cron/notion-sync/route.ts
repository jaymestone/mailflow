import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pullStatusOverridesFromNotion, syncConversationsToNotion } from "@/lib/notion/sync";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 60;

/** Both halves must finish inside cron-job.org's 30-second disconnect, not
 * Vercel's 60-second ceiling above -- the trigger is the tighter of the
 * two, and its disconnect KILLS the in-flight function rather than just
 * misreporting it, so a row written but not yet recorded is lost. The
 * conversations tick stops at 18s for the same reason.
 *
 * These are measured from the request's startedAt, not from each phase, so
 * they are positions on one shared clock: the push gets the first 18
 * seconds, the pull whatever remains up to 24, and the last six are left
 * for an in-flight Notion call to return plus the heartbeat write.
 *
 * Getting this wrong is not a slow sync, it is a stuck one: every run dies
 * at the same point and the backlog never clears, which is what left 116
 * rows pending behind a 40s push budget. */
const PUSH_DEADLINE_MS = 18_000;
const PULL_DEADLINE_MS = 24_000;

/** The Booking Pipeline database under Booking Notes. Hard-coded rather
 * than an env var: there is exactly one, and a wrong value here would
 * quietly write 300 booking rows into whatever other database the id
 * pointed at. */
const DATABASE_ID = "558b5fcae3cb4c3aacce10845f5d0b23";

export async function POST(request: Request) {
  const startedAt = Date.now();

  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    // 200, not an error: an unconfigured sync is a normal state for a
    // deploy that has not had the token added, and a failing cron would
    // raise a health alert for something nobody has broken.
    return NextResponse.json({ skipped: true, reason: "NOTION_TOKEN is not set" });
  }

  const admin = createAdminClient();
  const push = await syncConversationsToNotion(admin, {
    databaseId: DATABASE_ID,
    token,
    startedAt,
    deadlineMs: PUSH_DEADLINE_MS,
  });
  // Pull second, and only with whatever time is left: a backlog of
  // outbound changes matters more than noticing an edit a few minutes
  // sooner, and pulling is pointless on rows the push has not reached.
  const pull = await pullStatusOverridesFromNotion(admin, {
    token,
    startedAt,
    deadlineMs: PULL_DEADLINE_MS,
  });
  const result = { ...push, pull };
  await recordHeartbeat(admin, "notion-sync-tick", result);
  return NextResponse.json({ ...result, elapsedMs: Date.now() - startedAt });
}
