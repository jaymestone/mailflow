import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "@/lib/gmail/client";
import { getCurrentHistoryId, listNewMessageIds } from "@/lib/gmail/history";
import { fetchGmailMessage } from "@/lib/gmail/messages";
import { isBounceMessage } from "./bounceDetection";
import { matchInboundMessage } from "./matching";
import { classifyReply } from "./classify";

export type ReplyTickResult = {
  accountsPolled: number;
  messagesFetched: number;
  bounces: number;
  replies: number;
  suppressed: number;
  errors: { account: string; error: string }[];
};

export async function runReplyPollTick(supabase: SupabaseClient): Promise<ReplyTickResult> {
  const result: ReplyTickResult = {
    accountsPolled: 0,
    messagesFetched: 0,
    bounces: 0,
    replies: 0,
    suppressed: 0,
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
        if (bounce) {
          category = "bounce";
          result.bounces++;
        } else {
          const classified = await classifyReply(email.subject, email.bodyText);
          category = classified.category;
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
          classified_at: new Date().toISOString(),
        });

        if (category === "bounce" || category === "opt_out") {
          // suppression.email has an expression unique index (lower(email)), which
          // Supabase's upsert onConflict can't target directly — check-then-insert instead.
          const { data: alreadySuppressed } = await supabase
            .from("suppression")
            .select("id")
            .ilike("email", email.fromEmail)
            .maybeSingle();
          if (!alreadySuppressed) {
            const { error: suppressError } = await supabase.from("suppression").insert({
              email: email.fromEmail,
              reason: category === "bounce" ? "bounce" : "opt_out",
              source_campaign_id: match.campaignId,
            });
            if (!suppressError) result.suppressed++;
          }
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
