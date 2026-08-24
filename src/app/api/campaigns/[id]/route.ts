import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Archive/unarchive — hides a campaign from the default list without
// touching its members, templates, or send/reply history. Archiving an
// active campaign also pauses it, since a hidden campaign should not keep
// sending in the background.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { archived } = await request.json();
  if (typeof archived !== "boolean") {
    return NextResponse.json({ error: "archived (boolean) required" }, { status: 400 });
  }

  const supabase = await createClient();

  if (archived) {
    const { data: campaign } = await supabase.from("campaigns").select("status").eq("id", id).single();
    const update: { archived_at: string; status?: string } = { archived_at: new Date().toISOString() };
    if (campaign?.status === "active") update.status = "paused";
    const { error } = await supabase.from("campaigns").update(update).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase.from("campaigns").update({ archived_at: null }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// Permanently deletes the campaign. Cascades (already declared on the
// foreign keys, not handled here) take its templates, members, and
// outbound_sends with it; inbound_messages that matched it keep their row
// with matched_campaign_id set to null, preserving reply history.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { error } = await supabase.from("campaigns").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
