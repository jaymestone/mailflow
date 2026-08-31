import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contact_notes")
    .select("id, body, created_at")
    .eq("contact_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notes: data ?? [] });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { body } = await request.json();
  if (!body?.trim()) return NextResponse.json({ error: "body required" }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contact_notes")
    .insert({ contact_id: id, body: body.trim() })
    .select("id, body, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ note: data });
}

export async function DELETE(request: Request) {
  const { noteId } = await request.json();
  if (!noteId) return NextResponse.json({ error: "noteId required" }, { status: 400 });

  const supabase = await createClient();
  const { error } = await supabase.from("contact_notes").delete().eq("id", noteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
