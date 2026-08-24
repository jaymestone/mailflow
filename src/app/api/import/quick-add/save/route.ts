import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { QuickAddRow } from "@/lib/import/quickAdd";

export const maxDuration = 60;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    contacts,
    listId,
    newListName,
    segmentName,
    campaignId,
  }: {
    contacts: QuickAddRow[];
    listId?: string;
    newListName?: string;
    segmentName?: string;
    campaignId?: string;
  } = await request.json();

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return NextResponse.json({ error: "contacts (non-empty array) required" }, { status: 400 });
  }

  let resolvedListId: string | null = listId || null;
  if (!resolvedListId && newListName?.trim()) {
    const { data: existingList } = await supabase
      .from("lists")
      .select("id")
      .ilike("name", newListName.trim())
      .maybeSingle();
    if (existingList) {
      resolvedListId = existingList.id;
    } else {
      const { data: created, error: listError } = await supabase
        .from("lists")
        .insert({ name: newListName.trim() })
        .select("id")
        .single();
      if (listError) return NextResponse.json({ error: listError.message }, { status: 500 });
      resolvedListId = created.id;
    }
  }

  const { data: existingContacts } = await supabase.from("contacts").select("id, email");
  const existingByEmail = new Map((existingContacts ?? []).map((c) => [c.email.toLowerCase(), c.id]));

  const toInsert: Record<string, unknown>[] = [];
  const seenNew = new Set<string>();
  let skippedDuplicate = 0;
  let invalid = 0;

  for (const c of contacts) {
    const email = c.email?.trim();
    if (!email || !isValidEmail(email)) {
      invalid++;
      continue;
    }
    const lowerEmail = email.toLowerCase();
    if (existingByEmail.has(lowerEmail) || seenNew.has(lowerEmail)) {
      skippedDuplicate++;
      continue;
    }
    seenNew.add(lowerEmail);

    toInsert.push({
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      email,
      venue: c.venue || null,
      venue_type: c.venue_type || null,
      city: c.city || null,
      state: c.state || null,
      country: c.country || null,
      mobile: c.mobile || null,
      phone: c.phone || null,
      website: c.website || null,
      notes: c.notes || null,
      source: c.source || "Quick add",
      list_id: resolvedListId,
    });
  }

  let inserted: { id: string; email: string }[] = [];
  if (toInsert.length > 0) {
    const { data, error } = await supabase.from("contacts").insert(toInsert).select("id, email");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    inserted = data ?? [];
  }

  let segmentResult: { id: string; name: string } | null = null;
  if (segmentName?.trim() && inserted.length > 0) {
    const { data: segment, error: segmentError } = await supabase
      .from("saved_segments")
      .upsert({ name: segmentName.trim() }, { onConflict: "name" })
      .select()
      .single();
    if (segmentError) return NextResponse.json({ error: segmentError.message }, { status: 500 });

    const rows = inserted.map((c) => ({ segment_id: segment.id, contact_id: c.id }));
    const { error: memberError } = await supabase
      .from("saved_segment_contacts")
      .upsert(rows, { onConflict: "segment_id,contact_id", ignoreDuplicates: true });
    if (memberError) return NextResponse.json({ error: memberError.message }, { status: 500 });
    segmentResult = { id: segment.id, name: segment.name };
  }

  let addedToCampaign = 0;
  let skippedSuppressed = 0;
  if (campaignId && inserted.length > 0) {
    const { data: suppressed } = await supabase.from("suppression").select("email");
    const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email.toLowerCase()));
    const eligible = inserted.filter((c) => !suppressedEmails.has(c.email.toLowerCase()));
    skippedSuppressed = inserted.length - eligible.length;

    if (eligible.length > 0) {
      const rows = eligible.map((c) => ({ campaign_id: campaignId, contact_id: c.id }));
      const { data: added, error: addError } = await supabase
        .from("campaign_members")
        .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true })
        .select("id");
      if (addError) return NextResponse.json({ error: addError.message }, { status: 500 });
      addedToCampaign = added?.length ?? 0;
    }
  }

  return NextResponse.json({
    inserted: inserted.length,
    skippedDuplicate,
    invalid,
    listId: resolvedListId,
    segment: segmentResult,
    addedToCampaign,
    skippedSuppressed,
  });
}
