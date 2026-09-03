import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "@/lib/gmail/client";
import { getCurrentHistoryId, listNewMessageIds } from "@/lib/gmail/history";
import { fetchGmailMessage } from "@/lib/gmail/messages";
import { applyGmailLabel, CATEGORY_LABEL_NAMES, getOrCreateLabelId } from "@/lib/gmail/labels";
import { classifyBounce } from "./bounceDetection";
import { matchInboundMessage } from "./matching";
import { classifyReply } from "./classify";
import type { ReplyCategory } from "./types";

const DEFAULT_OOO_SNOOZE_DAYS = 7;

// cron-job.org's own client-side request timeout is a confirmed hard 30s
// ceiling (checked directly — not configurable even on request), shorter
// than this route's Vercel maxDuration (60s). A burst of new messages
// (e.g. a pile of bounces landing at once, or several replies that each
// need a real classifyReply call) can take long enough to process that
// cron-job.org disconnects — which actually kills the in-flight function,
// not just misreports it, so anything still queued behind the disconnect
// point is lost progress for this run. Capping how many *newly seen*
// messages get processed per invocation keeps a normal run comfortably
// under that ceiling; a message already recorded in inbound_messages is a
// cheap lookup and doesn't count against this cap.
const MAX_NEW_MESSAGES_PER_TICK = 5;

export type ReplyTickResult = {
  accountsPolled: number;
  messagesFetched: number;
  bounces: number;
  softBounces: number;
  replies: number;
  suppressed: number;
  pausedElsewhere: number;
  removedForReplacement: number;
  errors: { account: string; error: string }[];
};

/** A stated return date can be missing, unparseable, or already in the
 * past (e.g. the auto-reply's date already elapsed by the time we poll) —
 * any of those fall back to a fixed snooze so the sequence never stays
 * blocked waiting on a return date that'll never gate anything. */
function resolveResumeAt(oooReturnDate: string | null): string {
  const fallback = new Date(Date.now() + DEFAULT_OOO_SNOOZE_DAYS * 24 * 60 * 60 * 1000);
  if (!oooReturnDate) return fallback.toISOString();
  const parsed = new Date(`${oooReturnDate}T09:00:00`);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) return fallback.toISOString();
  return parsed.toISOString();
}

export async function runReplyPollTick(supabase: SupabaseClient): Promise<ReplyTickResult> {
  const result: ReplyTickResult = {
    accountsPolled: 0,
    messagesFetched: 0,
    bounces: 0,
    softBounces: 0,
    replies: 0,
    suppressed: 0,
    pausedElsewhere: 0,
    removedForReplacement: 0,
    errors: [],
  };

  // Every connected account is polled, not just the Reply-To inbox: bounce
  // notifications land in each sending address's own mailbox (SMTP behavior),
  // while human replies land in whichever address is set as Reply-To.
  const { data: accounts } = await supabase
    .from("connected_accounts")
    .select("id, email_address, last_history_id")
    .eq("status", "active");

  // Shared across the whole tick so each account's Gmail labels are listed
  // at most once, not once per message — see getOrCreateLabelId.
  const labelCache = new Map<string, string>();

  for (const account of accounts ?? []) {
    result.accountsPolled++;
    try {
      const accessToken = await getAccessToken(supabase, account.id);

      if (!account.last_history_id) {
        const historyId = await getCurrentHistoryId(accessToken);
        await supabase
          .from("connected_accounts")
          .update({ last_history_id: historyId })
          .eq("id", account.id);
        continue;
      }

      const { messageIds, newHistoryId } = await listNewMessageIds(
        accessToken,
        account.last_history_id,
      );

      let newlyProcessed = 0;
      let hitBatchCap = false;

      for (const messageId of messageIds) {
        if (newlyProcessed >= MAX_NEW_MESSAGES_PER_TICK) {
          hitBatchCap = true;
          break;
        }
        // Scoped to this one message: a failure here (e.g. the classifier
        // API hiccups on this specific message) must not be mistaken for
        // an account-level problem, and must not stop the remaining
        // messages in this batch from being processed.
        try {
          const { data: existing } = await supabase
            .from("inbound_messages")
            .select("id")
            .eq("connected_account_id", account.id)
            .eq("gmail_message_id", messageId)
            .maybeSingle();
          if (existing) continue;

          newlyProcessed++;
          const email = await fetchGmailMessage(accessToken, messageId);
          if (email.labelIds.includes("SENT")) continue; // our own outbound copy

          result.messagesFetched++;
          const bounceInfo = classifyBounce(email);
          const match = await matchInboundMessage(supabase, email);

          let category: ReplyCategory;
          let oooReturnDate: string | null = null;
          if (bounceInfo.isBounce) {
            category = "bounce";
            result.bounces++;
            if (!bounceInfo.isHard) result.softBounces++;
          } else {
            const classified = await classifyReply(email.subject, email.bodyText);
            category = classified.category;
            oooReturnDate = classified.oooReturnDate;
            result.replies++;
          }

          await supabase.from("inbound_messages").insert({
            connected_account_id: account.id,
            gmail_message_id: email.gmailMessageId,
            gmail_thread_id: email.gmailThreadId,
            from_email: email.fromEmail,
            from_name: email.fromName,
            subject: email.subject,
            body_text: email.bodyText.slice(0, 10000),
            received_at: email.receivedAt,
            matched_campaign_id: match.campaignId,
            matched_contact_id: match.contactId,
            matched_outbound_send_id: match.outboundSendId,
            match_method: match.matchMethod,
            message_type: bounceInfo.isBounce ? "bounce" : "reply",
            classification_category: category,
            ooo_return_date: category === "ooo_temporary" ? oooReturnDate : null,
            classified_at: new Date().toISOString(),
          });

          // A bounce only suppresses/deletes when it's confirmed hard (see
          // bounceDetection.ts) — a soft bounce (mailbox full, greylisted,
          // temporary server issue) gets recorded and labeled like any other
          // bounce for visibility, but the address isn't touched, since it
          // may well still be good on the next attempt.
          const isHardBounce = category === "bounce" && bounceInfo.isHard;

          // Captured before the ooo_departed pause step below flips these
          // to 'paused' — so a later replacement contact can be re-enrolled
          // in the campaigns this contact was actually being pursued in,
          // not an empty list because the snapshot was taken too late.
          let activeCampaignIds: string[] = [];
          if ((isHardBounce || category === "ooo_departed" || category === "opt_out") && match.contactId) {
            const { data: memberships } = await supabase
              .from("campaign_members")
              .select("campaign_id")
              .eq("contact_id", match.contactId)
              .eq("member_status", "active");
            activeCampaignIds = (memberships ?? []).map((m) => m.campaign_id);
          }

          if (isHardBounce || category === "opt_out" || category === "ooo_departed") {
            // suppression.email has an expression unique index (lower(email)), which
            // Supabase's upsert onConflict can't target directly — check-then-insert instead.
            const { data: alreadySuppressed } = await supabase
              .from("suppression")
              .select("id")
              .ilike("email", email.fromEmail)
              .maybeSingle();
            if (!alreadySuppressed) {
              const reason = category === "bounce" ? "bounce" : category === "opt_out" ? "opt_out" : "departed";
              const { error: suppressError } = await supabase.from("suppression").insert({
                email: email.fromEmail,
                reason,
                source_campaign_id: match.campaignId,
              });
              if (!suppressError) result.suppressed++;
            }
          }

          // A departure/closure signal is true regardless of which artist was
          // being pitched, so it pauses every active sequence for this
          // contact, not just the one that got the reply.
          if (category === "ooo_departed" && match.contactId) {
            const { data: paused } = await supabase
              .from("campaign_members")
              .update({ member_status: "paused" })
              .eq("contact_id", match.contactId)
              .eq("member_status", "active")
              .select("id");
            result.pausedElsewhere += paused?.length ?? 0;
          }

          // "Away from my email until March 10th" is true regardless of
          // which campaign's message triggered the auto-reply — the same
          // reasoning as ooo_departed just above, so this snoozes every
          // active sequence for the contact, not only the one that got the
          // reply. (Scoping this to just match.campaignId was the bug: a
          // contact enrolled in two concurrent campaigns would keep getting
          // the other one's follow-ups sent straight through their stated
          // absence.) The send engine resumes normal cadence anchored to
          // their return date, not immediately or by resending.
          if (category === "ooo_temporary" && match.contactId) {
            await supabase
              .from("campaign_members")
              .update({ resume_at: resolveResumeAt(oooReturnDate) })
              .eq("contact_id", match.contactId)
              .eq("member_status", "active");
          }

          // A hard bounce means the address is dead (a soft bounce is left
          // alone entirely — see isHardBounce above); ooo_departed means
          // that *person* is gone; opt_out means they explicitly asked not
          // to be contacted again — in every case suppression already
          // stops this exact address from ever being recontacted, so
          // keeping the contact record around serves no purpose, and the
          // venue itself may still be worth a fresh pitch to someone else
          // down the line. Queue what's known about the venue first so a
          // later research pass can go find whoever replaced them, then
          // remove the now-dead contact (cascades to their
          // campaign_members, outbound_sends, notes, and segment
          // membership — history for a contact who can never be reached
          // again isn't useful to keep).
          if ((isHardBounce || category === "ooo_departed" || category === "opt_out") && match.contactId) {
            const { data: contact } = await supabase
              .from("contacts")
              .select("email, venue, venue_type, city, state, country, list_id")
              .eq("id", match.contactId)
              .single();
            if (contact) {
              await supabase.from("replacement_queue").insert({
                venue: contact.venue,
                venue_type: contact.venue_type,
                city: contact.city,
                state: contact.state,
                country: contact.country,
                list_id: contact.list_id,
                removed_contact_email: contact.email,
                removed_reason: category,
                campaign_ids: activeCampaignIds,
              });
              await supabase.from("contacts").delete().eq("id", match.contactId);
              result.removedForReplacement++;
            }
          }

          // Applied last and after every DB side effect above has already
          // succeeded — replies are actually read in Gmail, not this app,
          // so a labeling failure (e.g. a transient Gmail API error) must
          // never undo or block classification, matching, suppression, or
          // pausing, which already happened by this point.
          const labelId = await getOrCreateLabelId(accessToken, account.id, CATEGORY_LABEL_NAMES[category], labelCache);
          // Bounce/departed DSNs, OOO auto-replies, and opt-outs pile up
          // and clutter the primary inbox view with nothing worth reading
          // (every one is handled automatically — suppressed/deleted or
          // snoozed to a return date, no action needed) — archived out of
          // INBOX but still fully visible/filterable under their own label.
          const shouldArchive =
            category === "bounce" ||
            category === "ooo_departed" ||
            category === "ooo_temporary" ||
            category === "opt_out";
          await applyGmailLabel(accessToken, email.gmailMessageId, labelId, shouldArchive ? ["INBOX"] : undefined);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          result.errors.push({ account: `${account.email_address} (message ${messageId})`, error: message });
          // Deliberately not marked as an account error, and last_history_id
          // still advances past this message below (as long as the batch
          // cap wasn't hit) — otherwise one message that reliably fails to
          // classify would get re-fetched and re-fail on every future poll
          // forever, permanently stuck.
        }
      }

      // Only advance the checkpoint after getting through every message in
      // this batch — if the cap cut it short, leaving last_history_id where
      // it was means the next tick re-fetches the same full range. Anything
      // already processed this round is a cheap existing-row lookup and
      // gets skipped instantly; only the still-unprocessed remainder
      // actually costs time, so the batch naturally drains over successive
      // ticks instead of the excess being silently skipped forever.
      if (!hitBatchCap) {
        await supabase
          .from("connected_accounts")
          .update({ last_history_id: newHistoryId })
          .eq("id", account.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.errors.push({ account: account.email_address, error: message });
      await supabase
        .from("connected_accounts")
        .update({ status: "error", last_error: message })
        .eq("id", account.id);
    }
  }

  return result;
}
