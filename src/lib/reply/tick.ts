import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "@/lib/gmail/client";
import { getCurrentHistoryId, listNewMessageIds, searchMessageIds } from "@/lib/gmail/history";
import { fetchGmailMessage } from "@/lib/gmail/messages";
import { applyGmailLabel, CATEGORY_LABEL_NAMES, getOrCreateLabelId } from "@/lib/gmail/labels";
import { OAuthTokenRevokedError } from "@/lib/oauth/google";
import { classifyBounce } from "./bounceDetection";
import { matchInboundMessage } from "./matching";
import { classifyReply } from "./classify";
import type { ReplyCategory } from "./types";

const DEFAULT_OOO_SNOOZE_DAYS = 7;

// How far back the direct-search recovery path (see wasReset handling
// below) looks when a history checkpoint turns out to be unusable. Wide
// enough to comfortably cover a same-day gap; bounded so a truly old/never-
// polled account doesn't try to pull an unbounded amount of mail.
const RESET_RECOVERY_SEARCH_QUERY = "newer_than:2d";

// Separate from, and much smaller than, MAX_NEW_MESSAGES_PER_TICK below --
// this one is shared across every account in the tick combined, not
// per-account. If several accounts reset in the same tick (a real
// possibility: whatever invalidates one checkpoint can plausibly affect
// several at once), each doing its own full MAX_NEW_MESSAGES_PER_TICK of
// recovery work would multiply straight past the 30s cron-job.org ceiling
// (see DEFAULT_BATCH_LIMIT's comment in send/tick.ts for the same
// constraint). Recovery drains over however many ticks it takes; nothing
// about it needs to finish in one shot the way it might feel like it should.
const MAX_RECOVERY_MESSAGES_PER_TICK = 3;

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
  // Populated whenever an account's history checkpoint turned out to be
  // unusable (see wasReset in gmail/history.ts) and a direct-search
  // recovery pass ran to cover the possible gap. Empty on a normal tick --
  // surfaced on the Health page so this is never silent the way it was
  // before (confirmed live: a real ~2-hour gap of unprocessed mail went
  // completely unnoticed until a screenshot revealed it).
  historyResets: { account: string; recovered: number }[];
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

/** Processes exactly one Gmail message: classify, match, insert into
 * inbound_messages, and take every downstream action (suppress, pause,
 * queue for replacement, label). Shared by both the normal history-based
 * poll and the direct-search recovery path below (see wasReset), so a gap
 * recovered by search goes through identically real processing, not a
 * simplified stand-in. Returns "processed" only when a brand-new message
 * actually went through the full pipeline (used by the caller to track its
 * per-tick budget); "skipped" covers everything else (already recorded,
 * our own sent copy, or an error that was itself already handled/logged
 * internally, matching the original inline behavior exactly). */
async function processOneMessage(
  supabase: SupabaseClient,
  account: { id: string; email_address: string },
  messageId: string,
  accessToken: string,
  labelCache: Map<string, string>,
  result: ReplyTickResult,
): Promise<"processed" | "skipped"> {
  try {
    const { data: existing } = await supabase
      .from("inbound_messages")
      .select("id")
      .eq("connected_account_id", account.id)
      .eq("gmail_message_id", messageId)
      .maybeSingle();
    if (existing) return "skipped";

    const email = await fetchGmailMessage(accessToken, messageId);
    if (email.labelIds.includes("SENT")) return "skipped"; // our own outbound copy

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
      // Raw threading headers, kept regardless of whether they led to
      // a match -- the only way to diagnose an unmatched message
      // after the fact (was In-Reply-To missing entirely, or present
      // but pointing at something we don't recognize?).
      in_reply_to: email.inReplyTo,
      references_header: email.references.join(" ") || null,
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
    // Only needed for the two reasons that actually queue for
    // replacement research below — opt_out never does (see there).
    let activeCampaignIds: string[] = [];
    if ((isHardBounce || category === "ooo_departed") && match.contactId) {
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

    // A hard bounce means the address is dead; ooo_departed means
    // that *person* is gone — in both cases suppression already
    // stops this exact address from ever being recontacted, so
    // keeping the contact record around serves no purpose, and the
    // venue itself is presumably still a real prospect for whoever
    // replaced them. Queue what's known about the venue first so a
    // later research pass can go find that replacement, then remove
    // the now-dead contact (cascades to their campaign_members,
    // outbound_sends, notes, and segment membership — history for a
    // contact who can never be reached again isn't useful to keep).
    //
    // opt_out is deliberately handled separately, below: it's a
    // preference signal, not a validity signal, and there's no way
    // to tell from the reply alone whether it represents just this
    // person or the whole organization's wishes (someone unsubscribing
    // might be the venue's only contact, or one of several — the
    // reply doesn't say). Auto-researching a replacement risks either
    // wasting effort on a venue that no longer exists (a real case:
    // one opt-out explicitly said the festival hadn't run since 2016)
    // or immediately re-approaching an org that just asked to be left
    // alone — so the contact still gets removed (suppression already
    // covers recontact regardless), it's just never queued to look
    // for someone else there.
    if ((isHardBounce || category === "ooo_departed") && match.contactId) {
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
    } else if (category === "opt_out" && match.contactId) {
      await supabase.from("contacts").delete().eq("id", match.contactId);
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
    const removeLabelIds: string[] = [];
    if (shouldArchive) removeLabelIds.push("INBOX");
    // Gmail's own spam filter can flag a genuine reply to an outbound
    // campaign as spam -- confirmed live: a real "interested" reply from a
    // festival contact landed in Spam, invisible in the normal inbox even
    // though Mailflow had correctly matched, classified, and labeled it.
    // Anything reaching this point has already been matched/classified as
    // a real reply, so by definition it isn't actually spam -- always
    // un-spam it rather than leaving a genuine, actionable reply sitting
    // somewhere Jayme would never think to check.
    if (email.labelIds.includes("SPAM")) removeLabelIds.push("SPAM");
    await applyGmailLabel(accessToken, email.gmailMessageId, labelId, removeLabelIds.length > 0 ? removeLabelIds : undefined);
    return "processed";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    result.errors.push({ account: `${account.email_address} (message ${messageId})`, error: message });
    // Deliberately not marked as an account error, and the checkpoint still
    // advances past this message (as long as the batch cap wasn't hit) --
    // otherwise one message that reliably fails to classify would get
    // re-fetched and re-fail on every future poll forever, permanently
    // stuck.
    //
    // A 404 specifically means Gmail no longer has this message at
    // all (permanently deleted, not just moved) -- retrying can never
    // succeed. Left alone, that's worse than the general case above:
    // since nothing ever gets inserted into inbound_messages for it,
    // the `existing` check never learns to skip it, so it keeps
    // re-occupying one of this tick's MAX_NEW_MESSAGES_PER_TICK slots
    // forever. If several such messages cluster together (confirmed
    // live: an account reconnected after a multi-week gap had a
    // backlog where the first 5 history entries were all permanently-
    // deleted messages), hitBatchCap never clears and the checkpoint
    // never advances past them -- which blocks every real message
    // behind them too, indefinitely, not just the dead ones. A stub
    // row here is enough for `existing` to skip it next time, without
    // pretending it was actually classified as anything.
    if (message.includes("Gmail get message failed: 404")) {
      // Best-effort: if even this insert fails, the message just
      // falls back to the pre-existing (already-safe, if slower to
      // recover from) retry-forever behavior rather than throwing out
      // of a catch block that's supposed to isolate one message's
      // failure from the rest of the batch.
      await supabase
        .from("inbound_messages")
        .insert({
          connected_account_id: account.id,
          gmail_message_id: messageId,
          from_email: "(unfetchable)",
          subject: "(Gmail returned 404 -- message no longer exists)",
          received_at: new Date().toISOString(),
          message_type: "unknown",
        })
        .then(null, () => {});
    }
    return "skipped";
  }
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
    historyResets: [],
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

  // Tick-wide (not per-account) budget for reset-recovery work -- see
  // MAX_RECOVERY_MESSAGES_PER_TICK above.
  let recoveryProcessedThisTick = 0;

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

      const { messageIds, newHistoryId, wasReset } = await listNewMessageIds(
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
        const outcome = await processOneMessage(supabase, account, messageId, accessToken, labelCache, result);
        if (outcome === "processed") newlyProcessed++;
      }

      // A reset checkpoint means the *incremental* path can no longer see
      // whatever arrived between the old (now-invalid) checkpoint and this
      // moment -- that gap used to be silently and permanently lost (see
      // the direct-search recovery this replaces). Falling back to a plain
      // message search covers it: anything already processed is a cheap
      // existing-row skip inside processOneMessage, so this is safe to run
      // even when the "gap" turns out to be empty or already handled.
      // Set when the *shared, tick-wide* recovery budget (not this
      // account's own cap) is what cut recovery short -- distinct from
      // hitBatchCap below, which only reflects this one account's own
      // MAX_NEW_MESSAGES_PER_TICK. Matters for the checkpoint-advance
      // decision just below: if the shared budget ran out, this account's
      // gap isn't actually fully covered yet, so the checkpoint must stay
      // put and retry (searchMessageIds is idempotent via the existing-row
      // check, so retrying is cheap) rather than advancing past
      // still-unrecovered messages.
      let recoveryIncomplete = false;

      if (wasReset) {
        let recovered = 0;
        try {
          const candidateIds = await searchMessageIds(accessToken, RESET_RECOVERY_SEARCH_QUERY);
          for (const messageId of candidateIds) {
            if (recoveryProcessedThisTick >= MAX_RECOVERY_MESSAGES_PER_TICK) {
              recoveryIncomplete = true;
              break;
            }
            if (newlyProcessed >= MAX_NEW_MESSAGES_PER_TICK) {
              hitBatchCap = true;
              break;
            }
            const outcome = await processOneMessage(supabase, account, messageId, accessToken, labelCache, result);
            if (outcome === "processed") {
              newlyProcessed++;
              recovered++;
              recoveryProcessedThisTick++;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          result.errors.push({ account: `${account.email_address} (reset recovery search)`, error: message });
        }
        result.historyResets.push({ account: account.email_address, recovered });
      }

      // Only advance the checkpoint after getting through every message in
      // this batch — if a cap cut it short, leaving last_history_id where it
      // was means the next tick retries the same range. Anything already
      // processed this round is a cheap existing-row lookup and gets
      // skipped instantly; only the still-unprocessed remainder actually
      // costs time, so the batch naturally drains over successive ticks
      // instead of the excess being silently skipped forever.
      //
      // On a reset, that means: only advance once recovery actually
      // exhausted its candidate list without hitting *either* cap (its own
      // account cap, or the tick-wide recovery budget) -- advancing early
      // would mean the next tick no longer has wasReset:true to re-trigger
      // recovery with (the checkpoint would look valid again), so whatever
      // recovery hadn't gotten to yet would never get a second chance.
      const shouldAdvance = wasReset ? !hitBatchCap && !recoveryIncomplete : !hitBatchCap;
      if (shouldAdvance) {
        await supabase
          .from("connected_accounts")
          .update({ last_history_id: newHistoryId })
          .eq("id", account.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.errors.push({ account: account.email_address, error: message });
      // Only a confirmed-revoked/expired token means this account actually
      // needs a human to reconnect it. Any other failure here (a network
      // blip, a transient Supabase/Vault read, a Gmail API hiccup) is
      // logged above but otherwise left alone -- the account stays
      // 'active' so the next tick, ~15 minutes away, just tries again
      // instead of permanently benching a healthy account over one bad
      // moment (confirmed live: this was silently taking every account
      // down at once on an ordinary transient error, not a real mass
      // token failure).
      if (err instanceof OAuthTokenRevokedError) {
        await supabase
          .from("connected_accounts")
          .update({ status: "error", last_error: message })
          .eq("id", account.id);
      }
    }
  }

  return result;
}
