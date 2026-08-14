import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const filters = await request.json();

  const supabase = await createClient();

  let query = supabase.from("contacts").select("id, email");
  if (filters.list_id) query = query.eq("list_id", filters.list_id);
  if (filters.state) query = query.ilike("state", filters.state);
  if (filters.city) query = query.ilike("city", filters.city);
  if (filters.country) query = query.ilike("country", filters.country);

  const { data: matchingContacts, error: contactsError } = await query;
  if (contactsError) return NextResponse.json({ error: contactsError.message }, { status: 500 });
  if (!matchingContacts || matchingContacts.length === 0) {
    return NextResponse.json({ added: 0, skippedSuppressed: 0 });
  }

  const { data: suppressed } = await supabase.from("suppression").select("email");
  const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email.toLowerCase()));

  const eligible = matchingContacts.filter((c) => !suppressedEmails.has(c.email.toLowerCase()));
  const skippedSuppressed = matchingContacts.length - eligible.length;

  if (eligible.length === 0) {
    return NextResponse.json({ added: 0, skippedSuppressed });
  }

  const rows = eligible.map((c) => ({ campaign_id: campaignId, contact_id: c.id }));
  const { data: inserted, error: insertError } = await supabase
    .from("campaign_members")
    .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true })
    .select("id");

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  return NextResponse.json({ added: inserted?.length ?? 0, skippedSuppressed });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const { contactId } = await request.json();

  const supabase = await createClient();
  const { error } = await supabase
    .from("campaign_members")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("contact_id", contactId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
