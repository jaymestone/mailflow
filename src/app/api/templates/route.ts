import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const { name, subject, body } = await request.json();

  // Subject is optional — a template meant for a follow-up step is allowed
  // to rely on the "Re: [step 1's subject]" auto-fill instead of its own.
  if (!name?.trim() || !body?.trim()) {
    return NextResponse.json({ error: "name and body required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("saved_templates")
    .upsert(
      { name: name.trim(), subject: (subject ?? "").trim(), body: body.trim() },
      { onConflict: "name" },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data });
}

export async function DELETE(request: Request) {
  const { id } = await request.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = await createClient();
  const { error } = await supabase.from("saved_templates").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
