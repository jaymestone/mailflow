import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: members }, { data: replies }] = await Promise.all([
    supabase
      .from("campaign_members")
      .select("campaign_id, member_status, current_step, last_sent_at, campaign:campaigns(name)")
      .eq("contact_id", id),
    supabase
      .from("inbound_messages")
      .select("matched_campaign_id, message_type, classification_category, subject, received_at")
      .eq("matched_contact_id", id)
      .order("received_at", { ascending: false }),
  ]);

  const campaigns = (members ?? []).map((m) => {
    const campaign = Array.isArray(m.campaign) ? m.campaign[0] : m.campaign;
    return {
      campaign_id: m.campaign_id,
      campaign_name: campaign?.name ?? "Unknown campaign",
      member_status: m.member_status,
      current_step: m.current_step,
      last_sent_at: m.last_sent_at,
      replies: (replies ?? [])
        .filter((r) => r.matched_campaign_id === m.campaign_id)
        .map((r) => ({
          message_type: r.message_type,
          classification_category: r.classification_category,
          subject: r.subject,
          received_at: r.received_at,
        })),
    };
  });

  return NextResponse.json({ campaigns });
}
