import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: tokens } = await supabase
    .from("link_tokens")
    .select("token, label, destination_url, step_number, campaign:campaigns(name)")
    .eq("contact_id", id);

  if (!tokens || tokens.length === 0) return NextResponse.json({ clicks: [] });

  const { data: clicks } = await supabase
    .from("link_clicks")
    .select("token, clicked_at, is_likely_bot")
    .in(
      "token",
      tokens.map((t) => t.token),
    )
    .order("clicked_at", { ascending: false });

  const byToken = new Map(tokens.map((t) => [t.token, t]));
  const result = (clicks ?? [])
    // Likely-bot clicks (security scanners prefetching every link) are
    // real rows worth keeping for anyone auditing the raw data later, but
    // they're not a signal Jayme should see as "this venue is interested."
    .filter((c) => !c.is_likely_bot)
    .map((c) => {
      const linkToken = byToken.get(c.token);
      const campaign = Array.isArray(linkToken?.campaign) ? linkToken.campaign[0] : linkToken?.campaign;
      return {
        label: linkToken?.label ?? "Unknown link",
        destination_url: linkToken?.destination_url ?? null,
        step_number: linkToken?.step_number ?? null,
        campaign_name: campaign?.name ?? "Unknown campaign",
        clicked_at: c.clicked_at,
      };
    });

  return NextResponse.json({ clicks: result });
}
