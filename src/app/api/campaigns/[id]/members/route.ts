import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Takes explicit contact IDs (chosen via the recipient search/preview step)
// rather than filters, so the picker can either select every match or a
// hand-picked subset. Suppression is re-checked here defensively in case it
// changed between the search preview and this add call.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const { contactIds } = await request.json();

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return NextResponse.json({ error: "contactIds (non-empty array) required" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select("id, email")
    .in("id", contactIds);
  if (contactsError) return NextResponse.json({ error: contactsError.message }, { status: 500 });
  if (!contacts || contacts.length === 0) {
    return NextResponse.json({ added: 0, skippedSuppressed: 0 });
  }

  const { data: suppressed } = await supabase.from("suppression").select("email");
  const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email.toLowerCase()));

  const eligible = contacts.filter((c) => !suppressedEmails.has(c.email.toLowerCase()));
  const skippedSuppressed = contacts.length - eligible.length;

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
