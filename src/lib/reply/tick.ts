import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "@/lib/gmail/client";
import { getCurrentHistoryId, listNewMessageIds } from "@/lib/gmail/history";
import { fetchGmailMessage } from "@/lib/gmail/messages";
import { isBounceMessage } from "./bounceDetection";
import { matchInboundMessage } from "./matching";
import { classifyReply } from "./classify";

const DEFAULT_OOO_SNOOZE_DAYS = 7;

export type ReplyTickResult = {
  accountsPolled: number;
  messagesFetched: number;
  bounces: number;
  replies: number;
  suppressed: number;
  pausedElsewhere: number;
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
    replies: 0,
    suppressed: 0,
    pausedElsewhere: 0,
    errors: [],
  };

  // Every connected account is polled, not just the Reply-To inbox: bounce
  // notifications land in each sending address's own mailbox (SMTP behavior),
  // while human replies land in whichever address is set as Reply-To.
  const { data: accounts } = await supabase
    .from("connected_accounts")
    .select("id, email_address, last_history_id")
    .eq("status", "active");

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

      for (const messageId of messageIds) {
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

          const email = await fetchGmailMessage(accessToken, messageId);
          if (email.labelIds.includes("SENT")) continue; // our own outbound copy

          result.messagesFetched++;
          const bounce = isBounceMessage(email);
          const match = await matchInboundMessage(supabase, email);

          let category: string;
          let oooReturnDate: string | null = null;
          if (bounce) {
            category = "bounce";
            result.bounces++;
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
            message_type: bounce ? "bounce" : "reply",
            classification_category: category,
            ooo_return_date: category === "ooo_temporary" ? oooReturnDate : null,
            classified_at: new Date().toISOString(),
          });

          if (category === "bounce" || category === "opt_out" || category === "ooo_departed") {
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
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          result.errors.push({ account: `${account.email_address} (message ${messageId})`, error: message });
          // Deliberately not marked as an account error, and last_history_id
          // still advances past this message below — otherwise one message
          // that reliably fails to classify would get re-fetched and
          // re-fail on every future poll forever, permanently stuck.
        }
      }

      await supabase
        .from("connected_accounts")
        .update({ last_history_id: newHistoryId })
        .eq("id", account.id);
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
