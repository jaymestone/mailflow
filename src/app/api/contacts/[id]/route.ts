import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const EDITABLE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "venue",
  "venue_type",
  "city",
  "state",
  "country",
  "notes",
  "source",
  "mobile",
  "phone",
  "website",
  "list_id",
] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("contacts").select("*").eq("id", id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ contact: data });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const update: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) update[field] = typeof body[field] === "string" ? body[field].trim() || null : body[field];
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no editable fields provided" }, { status: 400 });
  }
  if ("email" in update && !update.email) {
    return NextResponse.json({ error: "email cannot be blank" }, { status: 400 });
  }
  update.updated_at = new Date().toISOString();

  const supabase = await createClient();
  const { data, error } = await supabase.from("contacts").update(update).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ contact: data });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { error } = await supabase.from("contacts").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
