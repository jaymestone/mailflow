import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runGeocodeTick } from "@/lib/geocode/tick";

export const maxDuration = 60;

// Called by pg_cron (via pg_net) on a schedule, not by the app's UI.
// Authenticated with a shared secret instead of a user session, since this
// route is intentionally exempted from the session-based proxy check.
export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const result = await runGeocodeTick(supabase);
  return NextResponse.json(result);
}
