import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";

// Requires a signed-in session (enforced by the proxy) to authorize the
// action, but reads the refresh token via the service-role admin client
// since that RPC is intentionally restricted to service_role only.
export async function POST(request: Request) {
  const { accountId } = await request.json();
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: account } = await supabase
    .from("connected_accounts")
    .select("id, email_address")
    .eq("id", accountId)
    .single();
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  try {
    const accessToken = await getAccessToken(admin, accountId);
    const result = await sendGmailMessage(accessToken, {
      from: account.email_address,
      to: account.email_address,
      subject: "MailFlow test send",
      body: `This confirms ${account.email_address} can send through MailFlow via Gmail API.`,
      messageId: `<${randomUUID()}@${account.email_address.split("@")[1]}>`,
    });
    await supabase.from("connected_accounts").update({ status: "active", last_error: null }).eq("id", accountId);
    return NextResponse.json({ ok: true, messageId: result.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await supabase.from("connected_accounts").update({ status: "error", last_error: message }).eq("id", accountId);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
