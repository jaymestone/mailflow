import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { backfillClickClassification } from "@/lib/clicks/backfill";
import { recordHeartbeat } from "@/lib/health/heartbeat";

// Keeps click classification current.
//
// A click cannot be judged at the moment it arrives: the evidence that a
// fetch was a scanner is usually the NEXT fetch, a second or two later on
// a different artist. src/app/api/r/[token]/route.ts therefore records a
// fast provisional guess, and the considered verdict is made here once the
// contact's other clicks exist to compare it against.
//
// Cadence matters more than it looks. Step 3 of the roster campaigns picks
// which of three emails a venue receives from click_class, so any click
// still unclassified when their step 3 comes due is a venue who gets the
// "we never heard from you" note despite having opened two artists. Ten
// days separate step 2 from step 3, so daily is ample -- but it must
// actually run.
//
// Pure database work, no Gmail or LLM calls, and measured at ~10s for the
// full 22,745-click history of the largest campaign.
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  // No campaignId: every campaign with tracked links, so a new campaign
  // never has to be remembered and added here.
  const result = await backfillClickClassification(admin);
  await recordHeartbeat(admin, "reclassify-clicks-tick", result);
  return NextResponse.json(result);
}
