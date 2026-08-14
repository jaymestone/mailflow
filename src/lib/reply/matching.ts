import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedEmail } from "./types";

export type MatchResult = {
  campaignId: string | null;
  contactId: string | null;
  outboundSendId: string | null;
  matchMethod: "message_id" | "tracking_token" | "sender_email" | "unmatched";
};

const UNMATCHED: MatchResult = {
  campaignId: null,
  contactId: null,
  outboundSendId: null,
  matchMethod: "unmatched",
};

export async function matchInboundMessage(
  supabase: SupabaseClient,
  email: ParsedEmail,
): Promise<MatchResult> {
  // 1. In-Reply-To / References headers against the Message-ID we generated at send time.
  const candidateIds = [email.inReplyTo, ...email.references].filter(Boolean) as string[];
  for (const rfcId of candidateIds) {
    const { data } = await supabase
      .from("outbound_sends")
      .select("id, campaign_id, contact_id")
      .eq("rfc_message_id", rfcId)
      .maybeSingle();
    if (data) {
      return {
        campaignId: data.campaign_id,
        contactId: data.contact_id,
        outboundSendId: data.id,
        matchMethod: "message_id",
      };
    }
  }

  // 2. Hidden tracking token embedded in the sent email, echoed back in a reply.
  const tokenMatch = email.bodyText.match(/<!--\s*([a-f0-9]{16})\s*-->/i);
  if (tokenMatch) {
    const { data } = await supabase
      .from("outbound_sends")
      .select("id, campaign_id, contact_id")
      .eq("tracking_token", tokenMatch[1])
      .maybeSingle();
    if (data) {
      return {
        campaignId: data.campaign_id,
        contactId: data.contact_id,
        outboundSendId: data.id,
        matchMethod: "tracking_token",
      };
    }
  }

  // 3. Sender email against an active campaign member (last resort).
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("email", email.fromEmail)
    .maybeSingle();
  if (contact) {
    const { data: member } = await supabase
      .from("campaign_members")
      .select("campaign_id, contact_id")
      .eq("contact_id", contact.id)
      .eq("member_status", "active")
      .order("added_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (member) {
      return {
        campaignId: member.campaign_id,
        contactId: member.contact_id,
        outboundSendId: null,
        matchMethod: "sender_email",
      };
    }
  }

  return UNMATCHED;
}
