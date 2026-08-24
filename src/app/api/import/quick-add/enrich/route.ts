import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enrichQuickAddRow } from "@/lib/import/quickAdd";

export const maxDuration = 60;

export async function POST(request: Request) {
  await createClient();
  const { first_name, last_name, email, venue, city, state, country } = await request.json();
  if (!venue?.trim()) {
    return NextResponse.json({ error: "venue is required to enrich" }, { status: 400 });
  }

  try {
    const result = await enrichQuickAddRow({ first_name, last_name, email, venue, city, state, country });
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Enrichment failed: ${message}` }, { status: 500 });
  }
}
