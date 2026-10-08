import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runWorkbookTick } from "@/lib/workbook/tick";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 60;

/** Keeps the [MASTER] Tour Dates booking spreadsheet current: places newly
 * summarised conversations on the artist workbooks, honours the Leads tab's
 * "Bring into" picks, and rebuilds Leads and Routing. Every 15 minutes from
 * cron-job.org. See src/lib/workbook/tick.ts. */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const result = await runWorkbookTick(admin);
  const body = { ...result, elapsedMs: Date.now() - startedAt };
  await recordHeartbeat(admin, "workbook-tick", body);
  return NextResponse.json(body);
}
