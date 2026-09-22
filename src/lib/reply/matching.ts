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
    // The regex is case-insensitive (a client could plausibly uppercase
    // quoted text), but stored tokens are always lowercase hex — without
    // this the captured value would keep its original case and silently
    // fail to match a real, correctly-generated token.
    const { data } = await supabase
      .from("outbound_sends")
      .select("id, campaign_id, contact_id")
      .eq("tracking_token", tokenMatch[1].toLowerCase())
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
  //
  // Case-insensitive on purpose. Email local parts are technically
  // case-sensitive per RFC 5321, but in practice no real mail system
  // treats them that way, and the address a contact was *imported* with
  // frequently differs in casing from the one their mail client puts in
  // the From header. `.eq()` here was an exact, case-sensitive compare,
  // so any such contact silently fell through to unmatched -- confirmed
  // live 2026-09-22: a contact stored as `Josh@OtterCreekMusicFestival.com`
  // replied from `josh@ottercreekmusicfestival.com` with a genuinely
  // interested response, didn't match, and so was never excluded from
  // further automated follow-ups (send_engine_who_is_due only skips
  // members whose reply actually matched). 376 of ~6,270 contacts had
  // uppercase in their stored address at the time, so this was a
  // standing ~6% hole in reply detection, not a one-off.
  //
  // contacts already has a unique index on lower(email), so there can be
  // at most one case-insensitive match. PostgREST can't express
  // `lower(col) = lower($1)` directly, so this filters with ilike (the
  // same approach the suppression checks in reply/tick.ts already use)
  // and then re-verifies in JS -- ilike treats % and _ as wildcards, and
  // an address containing either could otherwise match a *different*
  // contact, which would attribute a reply to the wrong person.
  const { data: candidates } = await supabase
    .from("contacts")
    .select("id, email")
    .ilike("email", email.fromEmail.replace(/([%_\\])/g, "\\$1"))
    .limit(5);
  const wanted = email.fromEmail.toLowerCase();
  const contact = (candidates ?? []).find((c) => c.email.toLowerCase() === wanted) ?? null;
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
