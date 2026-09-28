import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedEmail } from "./types";
import { extractQuotedRecipients } from "./quotedRecipient";

export type MatchResult = {
  campaignId: string | null;
  contactId: string | null;
  outboundSendId: string | null;
  matchMethod: "message_id" | "tracking_token" | "quoted_recipient" | "sender_email" | "unmatched";
  /** Other contact records that this same reply evidently also covers.
   *
   * One human can sit in the list under two records -- a forwarding
   * address and the mailbox it forwards to, imported from two different
   * sources. A reply then answers the thread sent to one record while
   * arriving from the other's address, and only one of the two gets
   * credited. send_engine_who_is_due gates on matched_contact_id, so the
   * uncredited record keeps sending to someone who has already replied
   * (see quotedRecipient.ts for the live case this comes from).
   *
   * Everything listed here must have its sequences stopped alongside the
   * primary match. Empty in the ordinary case where both sides agree. */
  alsoImplicatedContactIds: string[];
};

const UNMATCHED: MatchResult = {
  campaignId: null,
  contactId: null,
  outboundSendId: null,
  matchMethod: "unmatched",
  alsoImplicatedContactIds: [],
};

/** Resolves an address to a contact, case-insensitively.
 *
 * contacts has a unique index on lower(email), so there is at most one
 * match. PostgREST can't express `lower(col) = lower($1)`, so this filters
 * with ilike and re-verifies in JS -- ilike treats % and _ as wildcards,
 * and an address containing either could otherwise match a *different*
 * contact, which would attribute a reply to the wrong person. */
async function contactByEmail(
  supabase: SupabaseClient,
  address: string,
): Promise<{ id: string; email: string } | null> {
  const { data } = await supabase
    .from("contacts")
    .select("id, email")
    .ilike("email", address.replace(/([%_\\])/g, "\\$1"))
    .limit(5);
  const wanted = address.toLowerCase();
  return (data ?? []).find((c) => c.email.toLowerCase() === wanted) ?? null;
}

async function activeMembership(
  supabase: SupabaseClient,
  contactId: string,
): Promise<{ campaign_id: string; contact_id: string } | null> {
  const { data } = await supabase
    .from("campaign_members")
    .select("campaign_id, contact_id")
    .eq("contact_id", contactId)
    .eq("member_status", "active")
    .order("added_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

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
        alsoImplicatedContactIds: await splitRecordIds(supabase, email, data.contact_id),
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
        alsoImplicatedContactIds: await splitRecordIds(supabase, email, data.contact_id),
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
  const senderContact = await contactByEmail(supabase, email.fromEmail);

  // 3a. The address the quoted original was actually addressed to.
  //
  // Checked BEFORE the sender fallback, because when the two disagree the
  // quoted recipient is the one that was mailed, and therefore the one
  // whose sequence is still running. Taking the sender instead is exactly
  // the failure this ordering exists to prevent -- it credits the reply to
  // a record that was never in the thread and leaves the real one sending.
  //
  // Only consulted when the header matching above found nothing, so this
  // cannot disturb the common case where threading works.
  const quotedRecipients = extractQuotedRecipients(email.bodyText, [email.fromEmail]);
  for (const address of quotedRecipients) {
    const recipient = await contactByEmail(supabase, address);
    if (!recipient || recipient.id === senderContact?.id) continue;
    const member = await activeMembership(supabase, recipient.id);
    if (!member) continue;
    return {
      campaignId: member.campaign_id,
      contactId: member.contact_id,
      outboundSendId: null,
      matchMethod: "quoted_recipient",
      // The sender is the same human under a second record. It has to
      // stop too, whether or not it is the one we credit.
      alsoImplicatedContactIds: senderContact ? [senderContact.id] : [],
    };
  }

  // 3b. Sender address against an active campaign member (last resort).
  if (senderContact) {
    const member = await activeMembership(supabase, senderContact.id);
    if (member) {
      return {
        campaignId: member.campaign_id,
        contactId: member.contact_id,
        outboundSendId: null,
        matchMethod: "sender_email",
        alsoImplicatedContactIds: await splitRecordIds(supabase, email, member.contact_id),
      };
    }
  }

  return UNMATCHED;
}

/** Finds contact records other than `primaryId` that this same reply
 * covers — the second record for a human who is in the list twice.
 *
 * Looks at both ends of the thread: the address the reply came FROM, and
 * the address the quoted original was addressed TO. Whichever of those is
 * not the record we credited is a record that was never told about this
 * reply, and would otherwise keep sending.
 *
 * Returns only contacts that actually have an active membership — there
 * is nothing to stop otherwise, and a caller acting on this list should
 * not have to re-check. */
async function splitRecordIds(
  supabase: SupabaseClient,
  email: ParsedEmail,
  primaryId: string | null,
): Promise<string[]> {
  const addresses = [email.fromEmail, ...extractQuotedRecipients(email.bodyText, [email.fromEmail])];
  const out: string[] = [];
  for (const address of addresses) {
    const contact = await contactByEmail(supabase, address);
    if (!contact || contact.id === primaryId || out.includes(contact.id)) continue;
    if (await activeMembership(supabase, contact.id)) out.push(contact.id);
  }
  return out;
}
