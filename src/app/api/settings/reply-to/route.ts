import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const { accountId } = await request.json();
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });

  const supabase = await createClient();
  const { error } = await supabase
    .from("app_settings")
    .update({ value: accountId, updated_at: new Date().toISOString() })
    .eq("key", "reply_to_account_id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
