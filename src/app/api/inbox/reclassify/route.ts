import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const VALID_CATEGORIES = ["interested", "not_interested", "follow_up", "ooo", "opt_out", "bounce", "unclear"];

export async function POST(request: Request) {
  const { id, category } = await request.json();
  if (!id || !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "id and a valid category are required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("inbound_messages")
    .update({ classification_category: category })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
