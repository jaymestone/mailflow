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

// How far back a history-reset recovery search looks. Gmail only retains
// ~1 week of history for the incremental API anyway, and this tick runs
// every ~5 minutes in normal operation, so a real reset-caused gap should
// almost always be far smaller than this -- generous enough to cover an
// account that was down for a couple of days, without searching so far
// back that an old reset (already covered by a previous recovery pass)
// gets needlessly re-scanned every time.
const HISTORY_RESET_RECOVERY_WINDOW_DAYS = 3;

// cron-job.org's own client-side request timeout is a confirmed hard 30s
// ceiling (checked directly — not configurable even on request), shorter
// than this route's Vercel maxDuration (60s), and disconnecting past that
// point actually kills the in-flight function rather than just misreporting
// it, losing progress on anything still queued behind it. A real (non-
// bounce) reply needs an actual classifyReply call, which allows up to 12s
// itself (see classify.ts) -- so a handful of genuine replies is already
// most of the 30s budget on its own, before any Gmail/DB overhead.
//
// This is a GLOBAL, tick-wide cap shared across every account combined, NOT
// per-account -- it used to be per-account, which meant 5 accounts each
// hitting their own cap could add up to 25 real classifyReply calls in one
// invocation, up to 300s of possible work against a 30s wall. That was
// always a latent risk, not something introduced later; it just took
// today's much higher reply volume (itself downstream of the send-side
// throughput fixes) to actually surface it -- confirmed live: three
// consecutive real automated ticks timed out at the full 60s with nothing
// reported to cron_health, even after unrelated changes elsewhere in this
// file were fully reverted, proving this was the actual bottleneck all
// along and not those other changes.
//
// Split into two separate tick-wide budgets, not one shared number --
// classifyBounce is an instant, local, rule-based check (no network call),
// so a bounce/DSN costs almost nothing beyond the Gmail fetch and a couple
// of DB writes; only a genuine reply needs the slow classifyReply call.
// Lumping both into one small shared cap (the original fix) meant a
// backlog dominated by cheap bounces drained at the same throttled pace as
// the expensive path required, even though almost none of it was actually
// at risk -- confirmed live, 2026-09-15: a real backlog held steady around
// 20-25 messages for 3+ hours because new mail arrived about as fast as
// the shared cap of 2/tick could clear it, regardless of type. Cheap gets
// real headroom; expensive stays exactly as conservative as before.
const MAX_CHEAP_MESSAGES_PER_TICK = 8;
const MAX_EXPENSIVE_MESSAGES_PER_TICK = 2;

/** Tick-wide (shared across every account) budget tracker, mutated in
 * place as processOneMessage consumes from whichever bucket a given
 * message turns out to need. */
type MessageBudget = { cheap: number; expensive: number };

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

/** Determines and applies the right Gmail label/archive/un-spam state for a
 * classified category -- shared by the normal first-time path below and
 * the label-only retry path (see retryLabelOnly), so both produce
 * identical Gmail-side results regardless of which one runs. */
async function applyCategoryLabel(
  accessToken: string,
  accountId: string,
  gmailMessageId: string,
  category: ReplyCategory,
  currentLabelIds: string[],
  labelCache: Map<string, string>,
): Promise<void> {
  const labelId = await getOrCreateLabelId(accessToken, accountId, CATEGORY_LABEL_NAMES[category], labelCache);
  // Bounce/departed DSNs, OOO auto-replies, and opt-outs pile up and
  // clutter the primary inbox view with nothing worth reading (every one
  // is handled automatically) — archived out of INBOX but still fully
  // visible/filterable under their own label.
  const shouldArchive =
    category === "bounce" || category === "ooo_departed" || category === "ooo_temporary" || category === "opt_out";
  const removeLabelIds: string[] = [];
  if (shouldArchive) removeLabelIds.push("INBOX");
  // Gmail's own spam filter can flag a genuine reply to an outbound
  // campaign as spam -- confirmed live: a real "interested" reply from a
  // festival contact landed in Spam, invisible in the normal inbox even
  // though Mailflow had correctly matched, classified, and labeled it.
  // Anything reaching this point has already been matched/classified as a
  // real reply, so by definition it isn't actually spam -- always un-spam
  // it rather than leaving a genuine, actionable reply sitting somewhere
  // Jayme would never think to check.
  if (currentLabelIds.includes("SPAM")) removeLabelIds.push("SPAM");
  await applyGmailLabel(accessToken, gmailMessageId, labelId, removeLabelIds.length > 0 ? removeLabelIds : undefined);
}

/** Retries just the Gmail label step for a message that's already
 * classified and recorded in inbound_messages but whose label never
 * successfully applied (see label_applied_at, migration 00000000000028) --
 * deliberately does NOT re-run classification/matching/suppression/pause/
 * replacement-queue, since those aren't safe to repeat on an
 * already-processed message. */
async function retryLabelOnly(
  supabase: SupabaseClient,
  account: { id: string; email_address: string },
  messageId: string,
  accessToken: string,
  labelCache: Map<string, string>,
  existing: { id: string; classification_category: ReplyCategory | null },
  budget: MessageBudget,
): Promise<"processed" | "skipped" | "budget-exhausted"> {
  if (!existing.classification_category) return "skipped"; // shouldn't happen, but nothing sane to label with
  // No LLM call here (reusing the already-stored category) -- counts
  // against the cheap budget, same as a bounce.
  if (budget.cheap <= 0) return "budget-exhausted"; // retried again next tick
  budget.cheap--;
  const email = await fetchGmailMessage(accessToken, messageId);
  await applyCategoryLabel(accessToken, account.id, email.gmailMessageId, existing.classification_category, email.labelIds, labelCache);
  await supabase.from("inbound_messages").update({ label_applied_at: new Date().toISOString() }).eq("id", existing.id);
  return "processed";
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
 * internally, matching the original inline behavior exactly). A third
 * outcome, "budget-exhausted", covers the specific case where this message
 * needed a budget bucket (cheap or expensive) that was already spent this
 * tick -- distinct from a plain "skipped" because the caller must not let
 * the checkpoint advance past a message that was never actually looked at,
 * even if the *other* bucket still had room left (see hitBatchCap below --
 * confirmed live, 2026-09-16: two genuine replies vanished with no
 * inbound_messages row at all, because cheap ran out mid-list while
 * expensive still had headroom, so the old both-exhausted check never
 * tripped and the checkpoint sailed past them as if the tick had fully
 * succeeded).
 *
 * Exported deliberately (not just for this file's own loop below): also
 * used directly by reply/reprocess.ts to recover a specific message that
 * fell through a gap like the one above, without needing it to resurface
 * through Gmail history first. */
export async function processOneMessage(
  supabase: SupabaseClient,
  account: { id: string; email_address: string },
  messageId: string,
  accessToken: string,
  labelCache: Map<string, string>,
  result: ReplyTickResult,
  budget: MessageBudget,
): Promise<"processed" | "skipped" | "budget-exhausted"> {
  try {
    const { data: existing } = await supabase
      .from("inbound_messages")
      .select("id, classification_category, label_applied_at")
      .eq("connected_account_id", account.id)
      .eq("gmail_message_id", messageId)
      .maybeSingle();

    // Already classified AND labeled -- fully done, nothing to do.
    if (existing?.label_applied_at) return "skipped";

    // Classified and recorded, but the Gmail label call itself never
    // succeeded (a transient API error, a rate limit) -- retry just that
    // step rather than the whole pipeline, since re-running
    // classification/matching/suppression/pause/replacement-queue on an
    // already-processed message risks double-applying side effects that
    // aren't safe to repeat (e.g. re-queuing the same venue for
    // replacement research, or re-deleting an already-deleted contact).
    if (existing) {
      return await retryLabelOnly(supabase, account, messageId, accessToken, labelCache, existing, budget);
    }

    const email = await fetchGmailMessage(accessToken, messageId);
    if (email.labelIds.includes("SENT")) return "skipped"; // our own outbound copy

    // classifyBounce is instant and local (no network call) -- safe to run
    // before either budget check below, since it's what decides which
    // budget actually applies.
    const bounceInfo = classifyBounce(email);

    // Cheap path (no LLM call) vs. expensive path (a real classifyReply
    // call, up to 12s) draw from separate tick-wide budgets -- see
    // MAX_CHEAP_MESSAGES_PER_TICK / MAX_EXPENSIVE_MESSAGES_PER_TICK above.
    // Bailing out here (before matching/insert/anything else) leaves
    // nothing behind, so this message is cleanly retried on a later tick,
    // same as hitting the old single shared cap used to behave.
    if (bounceInfo.isBounce) {
      if (budget.cheap <= 0) return "budget-exhausted";
      budget.cheap--;
    } else {
      if (budget.expensive <= 0) return "budget-exhausted";
      budget.expensive--;
    }

    result.messagesFetched++;
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

    // label_applied_at deliberately omitted here (stays null) -- set only
    // after applyCategoryLabel below actually succeeds, so a message whose
    // label call fails is correctly left in the "needs a label retry"
    // state (see retryLabelOnly) rather than looking fully done.
    const { data: inserted } = await supabase
      .from("inbound_messages")
      .insert({
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
      })
      .select("id")
      .single();

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
    // succeeded — replies are actually read in Gmail, not this app, so a
    // labeling failure (e.g. a transient Gmail API error) must never undo
    // or block classification, matching, suppression, or pausing, which
    // already happened by this point. If it does fail, the exception below
    // is caught and this message is left with label_applied_at still null
    // -- retryLabelOnly picks it back up on a later poll instead of it
    // being silently stuck forever (confirmed live, 2026-09-15: a Gmail
    // rate-limit incident left several classified messages permanently
    // unlabeled until this retry path existed).
    await applyCategoryLabel(accessToken, account.id, email.gmailMessageId, category, email.labelIds, labelCache);
    if (inserted) {
      await supabase.from("inbound_messages").update({ label_applied_at: new Date().toISOString() }).eq("id", inserted.id);
    }
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
    // re-occupying one of this tick's message-budget slots forever. If several such messages cluster together (confirmed
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
  const { data: rawAccounts } = await supabase
    .from("connected_accounts")
    .select("id, email_address, last_history_id, history_page_token")
    .eq("status", "active");

  // Rotate which account goes first each tick, same idea as send/tick.ts's
  // round-robin cursor. Without this, the shared message budget below
  // always goes to whichever accounts happen to come first in
  // this query's (unordered) result -- confirmed live, 2026-09-15:
  // stone@jaymestone.com, our highest-volume account with the largest real
  // backlog, made zero progress across many ticks because busier accounts
  // ahead of it in a consistent order used up the whole budget every time,
  // even though its own pagination was working fine. Rotating the start
  // point means every account gets first crack at the budget in turn.
  // Plain update (not upsert) to match this codebase's existing convention
  // for app_settings (see round_robin_cursor in send/tick.ts) -- the row is
  // pre-seeded once rather than auto-created here, so a missing key simply
  // no-ops (falls back to cursor 0 below) instead of failing.
  const { data: cursorRow } = await supabase.from("app_settings").select("value").eq("key", "reply_round_robin_cursor").maybeSingle();
  const cursor = typeof cursorRow?.value === "number" ? cursorRow.value : 0;
  const accounts = rawAccounts && rawAccounts.length > 0 ? [...rawAccounts.slice(cursor % rawAccounts.length), ...rawAccounts.slice(0, cursor % rawAccounts.length)] : rawAccounts;
  await supabase
    .from("app_settings")
    .update({ value: (cursor + 1) % Math.max(accounts?.length ?? 1, 1) })
    .eq("key", "reply_round_robin_cursor");

  // Shared across the whole tick so each account's Gmail labels are listed
  // at most once, not once per message — see getOrCreateLabelId.
  const labelCache = new Map<string, string>();

  // Tick-wide (not per-account) -- see MAX_CHEAP_MESSAGES_PER_TICK /
  // MAX_EXPENSIVE_MESSAGES_PER_TICK above for why this must be shared
  // across every account in the loop, not reset per account.
  const budget: MessageBudget = { cheap: MAX_CHEAP_MESSAGES_PER_TICK, expensive: MAX_EXPENSIVE_MESSAGES_PER_TICK };

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

      const { messageIds, newHistoryId, wasReset, truncated, nextPageToken } = await listNewMessageIds(
        accessToken,
        account.last_history_id,
        account.history_page_token,
      );

      let hitBatchCap = false;

      for (const messageId of messageIds) {
        if (budget.cheap <= 0 && budget.expensive <= 0) {
          hitBatchCap = true;
          break;
        }
        const outcome = await processOneMessage(supabase, account, messageId, accessToken, labelCache, result, budget);
        // A message that needed the specific bucket (cheap or expensive)
        // already spent this tick was never actually looked at -- the
        // checkpoint must not advance past it even though the *other*
        // bucket may still have room, or it's gone for good (see the
        // comment on processOneMessage's return type above).
        if (outcome === "budget-exhausted") hitBatchCap = true;
      }

      // Search-based recovery on a reset checkpoint. Was disabled the same
      // day it first shipped (2026-09-15) after causing repeated live
      // timeouts -- that turned out to be an unrelated, unbounded
      // pagination bug in listNewMessageIds itself (see MAX_HISTORY_PAGES
      // in gmail/history.ts), not this recovery path. Re-enabled
      // 2026-09-16 now that the real bottleneck is fixed: searchMessageIds
      // is already capped to one page of 50 specifically so this can never
      // repeat that timeout, and every result still goes through
      // processOneMessage's own existing-row check and budget gating, so
      // it can't double-process anything or blow the tick's time budget --
      // it just quietly finds nothing to do once the budget most of this
      // tick already spent runs out, same as any other message this late
      // in the loop.
      if (wasReset) {
        const recoveryIds = await searchMessageIds(accessToken, `newer_than:${HISTORY_RESET_RECOVERY_WINDOW_DAYS}d`);
        let recovered = 0;
        for (const messageId of recoveryIds) {
          const outcome = await processOneMessage(supabase, account, messageId, accessToken, labelCache, result, budget);
          if (outcome === "processed") recovered++;
        }
        result.historyResets.push({ account: account.email_address, recovered });
      }

      if (truncated) {
        // Pagination itself didn't finish -- persist exactly where it left
        // off so the next tick resumes from this page instead of
        // restarting from last_history_id and re-fetching the same early
        // pages forever (confirmed live, 2026-09-15: this is what froze
        // stone@jaymestone.com's checkpoint for hours once bounded
        // pagination shipped -- it never got far enough to see its own
        // genuinely new mail). last_history_id itself stays untouched, same
        // reasoning as before: it isn't safe to advance until the full
        // traversal actually completes.
        await supabase
          .from("connected_accounts")
          .update({ history_page_token: nextPageToken })
          .eq("id", account.id);
      } else if (!hitBatchCap) {
        // Full traversal completed (or completed a resumed one) and the
        // per-tick message budget didn't cut the batch short -- safe to
        // advance the real checkpoint, and clear any leftover resume
        // token so a future fresh traversal doesn't start from a stale
        // page belonging to an old startHistoryId.
        await supabase
          .from("connected_accounts")
          .update({ last_history_id: newHistoryId, history_page_token: null })
          .eq("id", account.id);
      }
      // Remaining case (hitBatchCap but not truncated): pagination found
      // the true bounds already, just the message-processing budget ran
      // out first -- leave last_history_id as-is, same as before this
      // page-token change, so the next tick simply re-fetches the same
      // (now cheap, existing-row-skipped) range and continues where message
      // processing left off.
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
