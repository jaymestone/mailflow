import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplacementResearchTick } from "@/lib/research/replacementTick";
import { recordHeartbeat } from "@/lib/health/heartbeat";

export const maxDuration = 60;

// OFF unless REPLACEMENT_RESEARCH_ENABLED is explicitly "true".
//
// This endpoint spends real money: findReplacement.ts calls claude-sonnet-5
// with up to three server-side web searches per venue. Measured 2026-09-27
// over the whole queue: 234 venues researched, 13 replacements found
// (5.6%), of which exactly one was ever mailed and none replied. Jayme
// switched off the cron-job.org schedule that drives it.
//
// Disabling a schedule in a third-party dashboard is easy to undo by
// accident months later, so the off state lives here too, and it is
// default-off: a fresh deploy or a new environment cannot start spending
// without someone deliberately adding the variable.
//
// The cheaper replacements for this are src/lib/research/parseReferral.ts
// (reads the successor out of the departure reply the venue already sent)
// and src/lib/research/findContactOnSite.ts (reads the venue's own contact
// page). Neither costs anything per lookup. The manual button on the
// Bounces page hits /api/research/replacement-tick and is unaffected, so a
// deliberate one-off lookup is still possible.
function researchEnabled(): boolean {
  return process.env.REPLACEMENT_RESEARCH_ENABLED === "true";
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!researchEnabled()) {
    // 200 rather than an error: a disabled job is a normal state, and a
    // failing cron would raise a health alert for something intentional.
    return NextResponse.json({
      skipped: true,
      reason: "Paid replacement research is switched off (REPLACEMENT_RESEARCH_ENABLED is not \"true\").",
    });
  }

  const admin = createAdminClient();
  const result = await runReplacementResearchTick(admin);
  await recordHeartbeat(admin, "replacement-research-tick", result);
  return NextResponse.json(result);
}
