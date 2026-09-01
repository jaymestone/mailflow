import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplacementResearchTick } from "@/lib/research/replacementTick";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const result = await runReplacementResearchTick(admin);
  await recordHeartbeat(admin, "replacement-research-tick", result);
  return NextResponse.json(result);
}
