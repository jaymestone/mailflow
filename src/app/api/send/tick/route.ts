import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runSendTick } from "@/lib/send/tick";

export const maxDuration = 60;

// Manual "Send Now" / dry-run from the campaign UI. Requires a signed-in
// session (enforced by the proxy) but executes with the admin client since
// the refresh-token RPC is service-role only.
export async function POST(request: Request) {
  await createClient(); // confirms a session exists via the same code path as every other authed route
  const admin = createAdminClient();
  const { dryRun } = await request.json().catch(() => ({ dryRun: false }));

  const result = await runSendTick(admin, { dryRun: Boolean(dryRun), ignoreSendWindow: true });
  return NextResponse.json(result);
}
