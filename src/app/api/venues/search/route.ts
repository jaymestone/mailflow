import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchContacts, type ContactSearchFilters } from "@/lib/venues/searchContacts";

const SEARCH_LIMIT = 500;

export async function POST(request: Request) {
  const filters: ContactSearchFilters = await request.json();
  const supabase = await createClient();

  const [result, { data: suppressed }] = await Promise.all([
    searchContacts(supabase, filters, { limit: SEARCH_LIMIT }),
    supabase.from("suppression").select("email"),
  ]);

  const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email.toLowerCase()));
  const rows = result.rows.map((c) => ({ ...c, suppressed: suppressedEmails.has(c.email.toLowerCase()) }));

  return NextResponse.json({
    rows,
    count: result.count,
    isRadiusMode: result.isRadiusMode,
    radiusNote: result.radiusNote,
    radiusCapped: result.radiusCapped,
  });
}
