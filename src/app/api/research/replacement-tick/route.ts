import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runReplacementResearchTick } from "@/lib/research/replacementTick";

export const maxDuration = 60;

export async function POST() {
  await createClient(); // confirms a session exists, same as every other authed route
  const admin = createAdminClient();
  const result = await runReplacementResearchTick(admin);
  return NextResponse.json(result);
}
