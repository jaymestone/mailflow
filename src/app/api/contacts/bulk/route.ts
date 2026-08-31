import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const { action, contactIds, listId } = await request.json();

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return NextResponse.json({ error: "contactIds (non-empty array) required" }, { status: 400 });
  }

  const supabase = await createClient();

  if (action === "move") {
    if (!listId) return NextResponse.json({ error: "listId required for move" }, { status: 400 });
    const { error } = await supabase.from("contacts").update({ list_id: listId }).in("id", contactIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, moved: contactIds.length });
  }

  if (action === "delete") {
    const { error } = await supabase.from("contacts").delete().in("id", contactIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: contactIds.length });
  }

  return NextResponse.json({ error: 'action must be "move" or "delete"' }, { status: 400 });
}
