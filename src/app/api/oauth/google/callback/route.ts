import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { exchangeCodeForTokens, decodeIdTokenEmail, GMAIL_OAUTH_SCOPES } from "@/lib/oauth/google";

function redirectToSettings(origin: string, status: string, detail?: string) {
  const url = new URL("/settings/accounts", origin);
  url.searchParams.set("oauth", status);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("google_oauth_state")?.value;
  cookieStore.delete("google_oauth_state");

  if (error) return redirectToSettings(origin, "error", error);
  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectToSettings(origin, "error", "invalid_state");
  }

  try {
    const tokens = await exchangeCodeForTokens(code, origin);
    const email = tokens.id_token ? decodeIdTokenEmail(tokens.id_token) : null;
    if (!email) return redirectToSettings(origin, "error", "no_email");
    if (!tokens.refresh_token) return redirectToSettings(origin, "error", "no_refresh_token");

    const admin = createAdminClient();

    const { data: account, error: upsertError } = await admin
      .from("connected_accounts")
      .upsert(
        {
          email_address: email,
          // Every sending account is the same person regardless of which
          // address actually sends — used as the "Name <email>" attribution
          // on quoted replies (see formatQuoteAttribution).
          display_name: "Jayme Stone",
          scopes: GMAIL_OAUTH_SCOPES,
          status: "active",
          last_error: null,
        },
        { onConflict: "email_address" },
      )
      .select("id")
      .single();

    if (upsertError || !account) {
      return redirectToSettings(origin, "error", upsertError?.message ?? "upsert_failed");
    }

    const { error: vaultError } = await admin.rpc("store_oauth_refresh_token", {
      p_account_id: account.id,
      p_token: tokens.refresh_token,
    });
    if (vaultError) return redirectToSettings(origin, "error", vaultError.message);

    return redirectToSettings(origin, "success", email);
  } catch (err) {
    return redirectToSettings(origin, "error", err instanceof Error ? err.message : "unknown");
  }
}
