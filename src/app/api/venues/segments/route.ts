import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("saved_segments")
    .select("id, name, saved_segment_contacts(count)")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const segments = (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    count: Array.isArray(s.saved_segment_contacts) ? (s.saved_segment_contacts[0]?.count ?? 0) : 0,
  }));
  return NextResponse.json({ segments });
}

export async function POST(request: Request) {
  const { name, contactIds } = await request.json();

  if (!name?.trim() || !Array.isArray(contactIds) || contactIds.length === 0) {
    return NextResponse.json({ error: "name and contactIds (non-empty array) required" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: segment, error: segmentError } = await supabase
    .from("saved_segments")
    .upsert({ name: name.trim() }, { onConflict: "name" })
    .select()
    .single();
  if (segmentError) return NextResponse.json({ error: segmentError.message }, { status: 500 });

  // Re-saving under an existing name replaces its membership with the
  // current selection, rather than merging — matches "save as template"'s
  // overwrite behavior. Insert the new set *before* removing anything
  // stale: if the insert fails, the segment is left with its old
  // membership intact (or a safe old+new superset if only the cleanup
  // below fails) — never emptied, which a delete-then-insert order would
  // risk if the insert step failed right after the delete had succeeded.
  const rows = contactIds.map((contact_id: string) => ({ segment_id: segment.id, contact_id }));
  const { error: insertError } = await supabase
    .from("saved_segment_contacts")
    .upsert(rows, { onConflict: "segment_id,contact_id", ignoreDuplicates: true });
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  const { error: clearError } = await supabase
    .from("saved_segment_contacts")
    .delete()
    .eq("segment_id", segment.id)
    .not("contact_id", "in", `(${contactIds.join(",")})`);
  if (clearError) return NextResponse.json({ error: clearError.message }, { status: 500 });

  return NextResponse.json({ segment: { id: segment.id, name: segment.name, count: contactIds.length } });
}

export async function PATCH(request: Request) {
  const { id, name } = await request.json();
  if (!id || !name?.trim()) return NextResponse.json({ error: "id and name required" }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("saved_segments")
    .update({ name: name.trim() })
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ segment: data });
}

export async function DELETE(request: Request) {
  const { id } = await request.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = await createClient();
  const { error } = await supabase.from("saved_segments").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
