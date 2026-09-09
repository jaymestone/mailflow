import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchAllMatchingContacts, type ContactSearchFilters } from "@/lib/venues/searchContacts";

// A single .in("id", [...]) or .upsert([...]) call is chunked at this size
// regardless of which path below produced the contact list — a several-
// thousand-row array in one request risks the URL-length limit for the
// former and an oversized request body for the latter; chunking is cheap
// insurance either way, not a real performance concern at this app's scale.
const CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Common tail for both request shapes below: given a set of candidate
 * {id, email} contacts, drops suppressed ones and upserts the rest as
 * campaign members (chunked, ignoring anyone already a member). */
async function enroll(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignId: string,
  contacts: { id: string; email: string }[],
): Promise<{ added: number; skippedSuppressed: number }> {
  if (contacts.length === 0) return { added: 0, skippedSuppressed: 0 };

  const { data: suppressed } = await supabase.from("suppression").select("email");
  const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email.toLowerCase()));

  const eligible = contacts.filter((c) => !suppressedEmails.has(c.email.toLowerCase()));
  const skippedSuppressed = contacts.length - eligible.length;
  if (eligible.length === 0) return { added: 0, skippedSuppressed };

  let added = 0;
  for (const batch of chunk(eligible, CHUNK_SIZE)) {
    const rows = batch.map((c) => ({ campaign_id: campaignId, contact_id: c.id }));
    const { data: inserted, error } = await supabase
      .from("campaign_members")
      .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw error;
    added += inserted?.length ?? 0;
  }
  return { added, skippedSuppressed };
}

// Takes either explicit contactIds (a hand-picked or preview-page selection)
// or filters (every contact matching a search, with no preview-page cap --
// see searchAllMatchingContacts) so the picker can enroll either a curated
// subset or an entire list regardless of size. Suppression is re-checked
// here defensively in case it changed between the search preview and this
// add call.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const body = await request.json();
  const supabase = await createClient();

  try {
    if (Array.isArray(body.contactIds) && body.contactIds.length > 0) {
      const contactIds: string[] = body.contactIds;
      const contacts: { id: string; email: string }[] = [];
      for (const batch of chunk(contactIds, CHUNK_SIZE)) {
        const { data, error } = await supabase.from("contacts").select("id, email").in("id", batch);
        if (error) throw error;
        contacts.push(...(data ?? []));
      }
      const result = await enroll(supabase, campaignId, contacts);
      return NextResponse.json(result);
    }

    if (body.filters && typeof body.filters === "object") {
      const filters: ContactSearchFilters = body.filters;
      const matched = await searchAllMatchingContacts(supabase, filters);
      const result = await enroll(
        supabase,
        campaignId,
        matched.map((c) => ({ id: c.id, email: c.email })),
      );
      return NextResponse.json({ ...result, totalMatched: matched.length });
    }

    return NextResponse.json({ error: "contactIds (non-empty array) or filters (object) required" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Bulk-pauses (or reactivates) selected contacts' membership in this
// campaign -- e.g. "these venues clicked Rakish's link, stop the generic
// roster sequence for them" before enrolling them in an artist-specific
// campaign instead. Deliberately an update, not the DELETE below: deleting
// a campaign_members row cascades to that contact's outbound_sends for
// this campaign (see the FK in the init migration), wiping their real send
// history. Pausing stops all future sends for this campaign but keeps the
// record of what was actually sent intact.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const { contactIds, member_status } = await request.json();

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return NextResponse.json({ error: "contactIds (non-empty array) required" }, { status: 400 });
  }
  if (member_status !== "paused" && member_status !== "active") {
    return NextResponse.json({ error: "member_status must be 'paused' or 'active'" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaign_members")
    .update({ member_status })
    .eq("campaign_id", campaignId)
    .in("contact_id", contactIds)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ updated: data?.length ?? 0 });
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
