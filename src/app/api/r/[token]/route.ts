import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { detectLikelyBot } from "@/lib/send/botDetection";

// A dead or unrecognized token still needs somewhere sane to land -- this
// URL only ever appears inside a real campaign email a recipient is
// actually looking at, so a bare 404 would be a broken-looking dead end
// where the agency roster page is a reasonable fallback instead.
const FALLBACK_URL = "https://www.jaymestone.com/agency";

/** Public link-click redirect for campaign emails (each artist's link is
 * rewritten to point here at send time -- see src/lib/send/clickTracking.ts).
 * Deliberately unauthenticated: the person clicking is an external venue
 * contact with no Mailflow session, not a logged-in user. This route is
 * listed in src/proxy.ts's PUBLIC_PATHS for exactly that reason -- without
 * it, the auth middleware would bounce every real click to /login instead
 * of the artist's actual page. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: linkToken } = await supabase
    .from("link_tokens")
    .select("destination_url, created_at")
    .eq("token", token)
    .maybeSingle();

  if (!linkToken) {
    return NextResponse.redirect(FALLBACK_URL);
  }

  const userAgent = request.headers.get("user-agent") ?? "";
  const isLikelyBot = detectLikelyBot(userAgent, linkToken.created_at);

  // Logged best-effort -- a failed insert must never turn a real click
  // into a broken link for the person who just clicked it.
  await supabase.from("link_clicks").insert({
    token,
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    user_agent: userAgent || null,
    is_likely_bot: isLikelyBot,
  });

  return NextResponse.redirect(linkToken.destination_url);
}
