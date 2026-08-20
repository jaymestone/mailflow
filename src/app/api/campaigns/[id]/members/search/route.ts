import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchContacts, type ContactSearchFilters } from "@/lib/venues/searchContacts";

const PREVIEW_LIMIT = 500;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const filters: ContactSearchFilters = await request.json();

  const supabase = await createClient();

  const [result, { data: suppressed }, { data: existingMembers }] = await Promise.all([
    searchContacts(supabase, filters, { limit: PREVIEW_LIMIT }),
    supabase.from("suppression").select("email"),
    supabase.from("campaign_members").select("contact_id").eq("campaign_id", campaignId),
  ]);

  const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email.toLowerCase()));
  const existingIds = new Set((existingMembers ?? []).map((m) => m.contact_id));

  const eligible = result.rows.filter(
    (c) => !suppressedEmails.has(c.email.toLowerCase()) && !existingIds.has(c.id),
  );
  const excludedSuppressed = result.rows.filter((c) => suppressedEmails.has(c.email.toLowerCase())).length;
  const excludedExisting = result.rows.filter(
    (c) => existingIds.has(c.id) && !suppressedEmails.has(c.email.toLowerCase()),
  ).length;

  return NextResponse.json({
    rows: eligible,
    fetchedCount: result.rows.length,
    totalMatched: result.count,
    excludedSuppressed,
    excludedExisting,
    isRadiusMode: result.isRadiusMode,
    radiusNote: result.radiusNote,
    radiusCapped: result.radiusCapped,
  });
}
