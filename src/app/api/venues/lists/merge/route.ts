import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Reassigns every contact from sourceId to targetId, then removes the
// now-empty source list. Reassignment happens first so a failure partway
// through leaves contacts correctly attributed rather than orphaned.
export async function POST(request: Request) {
  const { sourceId, targetId } = await request.json();
  if (!sourceId || !targetId || sourceId === targetId) {
    return NextResponse.json({ error: "sourceId and targetId (distinct) required" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: moved, error: moveError } = await supabase
    .from("contacts")
    .update({ list_id: targetId })
    .eq("list_id", sourceId)
    .select("id");
  if (moveError) return NextResponse.json({ error: moveError.message }, { status: 500 });

  const { error: deleteError } = await supabase.from("lists").delete().eq("id", sourceId);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  return NextResponse.json({ ok: true, moved: moved?.length ?? 0 });
}
