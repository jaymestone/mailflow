import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runGeocodeTick } from "@/lib/geocode/tick";

export const maxDuration = 60;

// Manual trigger from the /settings/geocoding page. Auth is enforced by the
// app-wide proxy (this route requires a signed-in session like any other).
export async function POST() {
  const supabase = await createClient();
  const result = await runGeocodeTick(supabase);
  return NextResponse.json(result);
}
