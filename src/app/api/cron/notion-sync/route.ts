import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncConversationsToNotion } from "@/lib/notion/sync";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 60;

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
  const result = await syncConversationsToNotion(admin, { databaseId: DATABASE_ID, token, startedAt });
  await recordHeartbeat(admin, "notion-sync-tick", result);
  return NextResponse.json({ ...result, elapsedMs: Date.now() - startedAt });
}
