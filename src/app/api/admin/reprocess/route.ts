import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reprocessStuckMessages } from "@/lib/reply/reprocess";

// Recovering a real backlog (2026-09-16: ~179 messages across 5 accounts)
// means real Gmail API calls plus, for the reply pass, real classifyReply
// calls -- comfortably past the 60s ceiling this project already treats as
// the practical maxDuration limit elsewhere. This is a manually-triggered
// admin action, not a cron tick under a 30s external-caller timeout, so
// there's no equivalent hard ceiling to respect here.
export const maxDuration = 300;

// Manual "Reprocess stuck messages" from the Health page. Requires a
// signed-in session (enforced by the proxy) but executes with the admin
// client since the refresh-token RPC is service-role only -- same pattern
// as /api/send/tick.
export async function POST(request: Request) {
  await createClient(); // confirms a session exists via the same code path as every other authed route
  const admin = createAdminClient();
  const { dryRun, windowDays } = await request.json().catch(() => ({ dryRun: true, windowDays: undefined }));

  const result = await reprocessStuckMessages(admin, { dryRun: dryRun ?? true, windowDays });
  return NextResponse.json(result);
}
