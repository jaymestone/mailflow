import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const { accountId } = await request.json();
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: refreshToken } = await admin.rpc("get_oauth_refresh_token", { p_account_id: accountId });
  if (refreshToken) {
    // Best-effort revoke with Google — don't block disconnect on this.
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    }).catch(() => {});
  }

  const { error } = await supabase
    .from("connected_accounts")
    .update({ status: "disconnected" })
    .eq("id", accountId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
