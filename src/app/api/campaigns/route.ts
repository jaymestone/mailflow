import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const { name, artists, notes } = await request.json();
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .insert({ name: name.trim(), artists: artists || null, notes: notes || null, status: "draft" })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
