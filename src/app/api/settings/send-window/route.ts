import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export async function POST(request: Request) {
  const { days, start_hour, end_hour, timezone } = await request.json();

  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    !days.every((d) => VALID_DAYS.includes(d)) ||
    !Number.isInteger(start_hour) ||
    !Number.isInteger(end_hour) ||
    start_hour < 0 ||
    start_hour > 23 ||
    end_hour < 0 ||
    end_hour > 23 ||
    start_hour >= end_hour ||
    typeof timezone !== "string" ||
    !timezone.trim()
  ) {
    return NextResponse.json({ error: "invalid send window" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("app_settings")
    .update({ value: { days, start_hour, end_hour, timezone }, updated_at: new Date().toISOString() })
    .eq("key", "send_window");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
