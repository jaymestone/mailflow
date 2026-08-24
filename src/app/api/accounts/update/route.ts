import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const { id, can_send, ramp_schedule, display_name } = await request.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof can_send === "boolean") update.can_send = can_send;
  if (ramp_schedule) update.ramp_schedule = ramp_schedule;
  if (display_name !== undefined) update.display_name = display_name?.trim() || null;

  const supabase = await createClient();
  const { error } = await supabase.from("connected_accounts").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
