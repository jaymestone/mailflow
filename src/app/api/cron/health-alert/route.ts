import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkAndSendAlerts } from "@/lib/health/alerts";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 30;

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const result = await checkAndSendAlerts(admin);
  await recordHeartbeat(admin, "health-alert-tick", result);
  return NextResponse.json(result);
}
