import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "crypto";
import { effectiveCap, pickNextAccount, type SendAccount } from "./roundRobin";
import { buildFollowUpContent } from "./buildFollowUp";
import { injectClickTracking } from "./clickTracking";
import { findUnresolvedTokens, resolveTemplate } from "@/lib/templates/resolve";
import { wrapEmailHtml } from "@/lib/templates/emailHtml";
import { formatFromAddress, getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { OAuthTokenRevokedError } from "@/lib/oauth/google";

// Per-account daily ramp caps (roundRobin.ts) already bound total volume for
// the day — this constant's only job is pacing *within* a tick: both
// avoiding a burst-sending pattern (risky from a personal/Workspace Gmail
// account) and, just as importantly, staying under cron-job.org's hard
// 30-second request timeout, which actually kills the in-flight Vercel
// function rather than just misreporting a slow run.
//
// This is a GLOBAL cap per tick, shared across every account and every
// active campaign combined, not per account. Lowered from 50 to 20 on
// 2026-09-14 after a real production incident: once send_engine_who_is_due
// started finding genuinely distinct-domain candidates instead of mostly
// domain-cap skips (see CANDIDATE_FETCH_LIMIT below), each tick's real work
// went up -- actual Gmail sends take real time (network + several DB
// writes each), unlike a same-domain skip which is nearly instant. A
// same-day attempt at 100/tick confirmed this: ticks started exceeding
// cron-job.org's 30s kill and dying before ever reporting their result to
// cron_health. 20/tick was confirmed live to complete comfortably inside
// that window. Total daily throughput is meant to come from cron cadence
// (ideally 5 minutes, not 15 -- more, smaller ticks add up to a higher
// safe daily total than fewer, larger ones ever could without risking this
// same timeout) rather than from pushing this number back up.
//
// app_settings.send_batch_limit_override can temporarily raise this for a
// single day from the database with no code deploy -- but re-learn from
// today: raising it back toward 50 risks the exact same timeout once real
// send volume is high, not just a bigger number for its own sake.
const DEFAULT_BATCH_LIMIT = 20;

// send_engine_who_is_due returns candidates oldest-enrolled-first, with no
// domain diversity -- if a single campaign enrolled a cluster of same-domain
// contacts together (confirmed live: 147 of 1,000 currently-due contacts
// share gmail.com, all enrolled in the same campaign), a straight
// DEFAULT_BATCH_LIMIT-sized slice of the queue can be dominated by
// duplicates of one domain. Since only one send per domain is allowed per
// tick (below), a tick like that burns nearly its whole batch on skips and
// sends almost nothing -- observed directly: 50 attempted, 49 skipped as
// "domain already sent this tick," 1 actually sent. Fetching a much larger
// candidate pool than the real per-tick send cap gives the loop enough
// room to find DEFAULT_BATCH_LIMIT worth of *distinct*-domain candidates
// even when the front of the queue is domain-clustered, without changing
// the actual real-send pacing limit itself.
const CANDIDATE_FETCH_LIMIT = 500;

// The one-send-per-domain-per-tick rule below exists to avoid dropping a
// burst of mail on a single ORGANISATION's mail server -- ten people at
// duke.edu all receiving outreach within the same minute is both a
// deliverability risk and plainly rude. That reasoning does not transfer
// to the big consumer mailbox providers: 463 gmail.com recipients are 463
// unrelated individuals who happen to use Google, not one institution
// being hammered. Google throttles on the SENDER's reputation and volume,
// which the per-account ramp caps already govern, and its bulk-sender
// thresholds start at 5,000/day -- far above anything here.
//
// Treating gmail.com as a single capped "domain" was therefore pure loss,
// and the cost was severe rather than theoretical. Confirmed live
// 2026-09-23: all 149 contacts then due were gmail.com addresses (the
// Canadian presenter/festival lists and Classical Pitch are heavily
// personal-address), so every 5-minute tick sent exactly ONE mail and
// skipped the other 148 -- a ceiling of ~108 sends/day against a
// configured capacity of 1,350. The CANDIDATE_FETCH_LIMIT workaround
// above cannot help here: it widens the search for distinct-domain
// candidates, but when the entire queue is one domain there are none to
// find.
//
// Exempting these providers leaves the rule doing exactly the job it was
// written for, on the domains it was written for. Per-tick volume stays
// bounded by DEFAULT_BATCH_LIMIT and per-day volume by the ramp caps, so
// nothing here raises total throughput above what was already configured
// -- it only stops that capacity being thrown away.
const CONSUMER_MAILBOX_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.ca",
  "yahoo.co.uk",
  "ymail.com",
  "hotmail.com",
  "hotmail.ca",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "live.ca",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "verizon.net",
  "sbcglobal.net",
  "att.net",
  "bellsouth.net",
  "cox.net",
  "earthlink.net",
  "juno.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "web.de",
  "sympatico.ca",
  "shaw.ca",
  "telus.net",
  "rogers.com",
  "bell.net",
  "videotron.ca",
  "cogeco.ca",
  "btinternet.com",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "libero.it",
  "bigpond.com",
]);

// Confirmed live, 2026-09-16: a tick ran long enough to hit cron-job.org's
// hard 30s kill (see DEFAULT_BATCH_LIMIT above for why that, not Vercel's
// own 60s maxDuration, is the real ceiling) while holding the send lock --
// the external kill terminates the whole invocation, so the `finally`
// block below that releases the lock never got to run, and every send
// this system attempted was blocked for the next ~5 minutes until the
// lock's own self-expiry caught up. DEFAULT_BATCH_LIMIT was already tuned
// to normally fit well inside 30s, but "normally" isn't a guarantee --
// this is the actual guardrail: the loop checks its own elapsed time and
// stops itself with room to spare, so the lock is reliably released
// through normal control flow instead of gambling on every tick finishing
// before an external, uncatchable kill.
const SOFT_DEADLINE_MS = 22_000;

type DueMember = {
  campaign_member_id: string;
  campaign_id: string;
  contact_id: string;
  current_step: number;
  next_step: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  venue: string | null;
  venue_short: string | null;
  city: string | null;
  state: string | null;
  venue_type: string | null;
  recipient_domain: string;
  subject: string;
  body: string;
};

export type SendTickResult = {
  attempted: number;
  sent: number;
  failed: number;
  skippedNoCapacity: number;
  skippedDomainCap: number;
  skippedUnresolvedTemplate: number;
  skippedQueryError: number;
  details: { email: string; outcome: string; account?: string }[];
};

function isWithinSendWindow(sendWindow: {
  days: string[];
  start_hour: number;
  end_hour: number;
  timezone: string;
}): boolean {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: sendWindow.timezone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value.toLowerCase().slice(0, 3);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);

  if (!sendWindow.days.includes(weekday ?? "")) return false;
  return hour >= sendWindow.start_hour && hour < sendWindow.end_hour;
}

function fetchPriorSends(supabase: SupabaseClient, member: DueMember) {
  return supabase
    .from("outbound_sends")
    .select(
      "step_number, subject_resolved, body_resolved, sent_at, rfc_message_id, gmail_thread_id, connected_account_id, connected_account:connected_accounts(email_address, display_name)",
    )
    .eq("campaign_member_id", member.campaign_member_id)
    .eq("status", "sent")
    .lt("step_number", member.next_step)
    .order("step_number", { ascending: true });
}

export async function runSendTick(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean; ignoreSendWindow?: boolean; softDeadlineMs?: number } = {},
): Promise<SendTickResult> {
  const startedAt = Date.now();
  const softDeadlineMs = opts.softDeadlineMs ?? SOFT_DEADLINE_MS;
  const timeIsUp = () => Date.now() - startedAt > softDeadlineMs;

  const result: SendTickResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedNoCapacity: 0,
    skippedDomainCap: 0,
    skippedUnresolvedTemplate: 0,
    skippedQueryError: 0,
    details: [],
  };

  if (!opts.dryRun) {
    const { data: lockAcquired } = await supabase.rpc("try_acquire_send_lock");
    if (!lockAcquired) {
      result.details.push({ email: "", outcome: "skipped: another tick is already running" });
      return result;
    }
  }

  try {
    const { data: settingsRows } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["round_robin_cursor", "reply_to_account_id", "send_window", "send_batch_limit_override"]);
    const settings = Object.fromEntries((settingsRows ?? []).map((r) => [r.key, r.value]));

    // A temporary, DB-set override of the per-tick pacing cap (see
    // DEFAULT_BATCH_LIMIT above) -- for deliberately catching up lost
    // volume on a specific day, without a code deploy. Expected to be
    // cleared back to unset shortly after, not left in place indefinitely.
    const batchLimit =
      typeof settings.send_batch_limit_override === "number" ? settings.send_batch_limit_override : DEFAULT_BATCH_LIMIT;

    if (!opts.ignoreSendWindow && settings.send_window && !isWithinSendWindow(settings.send_window)) {
      result.details.push({ email: "", outcome: "skipped: outside configured send window" });
      return result;
    }

    const replyToAccountId: string | null = settings.reply_to_account_id ?? null;
    let replyToEmail: string | undefined;
    if (replyToAccountId) {
      const { data: replyToAccount } = await supabase
        .from("connected_accounts")
        .select("email_address")
        .eq("id", replyToAccountId)
        .single();
      replyToEmail = replyToAccount?.email_address;
    }

    const { data: accountRows } = await supabase
      .from("connected_accounts")
      .select("id, email_address, display_name, ramp_schedule, ramp_started_at")
      .eq("can_send", true)
      .eq("status", "active");
    const accounts: SendAccount[] = accountRows ?? [];
    if (accounts.length === 0) {
      result.details.push({ email: "", outcome: "skipped: no active sending accounts" });
      return result;
    }

    const today = new Date();
    const todayDate = today.toISOString().slice(0, 10);
    const { data: counterRows } = await supabase
      .from("send_counters")
      .select("connected_account_id, sent_count")
      .eq("date", todayDate)
      .in(
        "connected_account_id",
        accounts.map((a) => a.id),
      );
    const sentCounts = new Map<string, number>(
      (counterRows ?? []).map((r) => [r.connected_account_id, r.sent_count]),
    );

    let cursor = typeof settings.round_robin_cursor === "number" ? settings.round_robin_cursor : -1;

    const { data: dueMembers } = await supabase.rpc("send_engine_who_is_due", {
      batch_limit: CANDIDATE_FETCH_LIMIT,
    });
    const members: DueMember[] = dueMembers ?? [];

    const domainsSentThisTick = new Set<string>();

    for (const member of members) {
      // The real per-tick pacing limit -- stop once we've actually sent
      // this many, regardless of how many more candidates remain in the
      // (deliberately oversized) pool fetched above.
      if (result.sent >= batchLimit) break;

      // See SOFT_DEADLINE_MS above -- stop with room to spare rather than
      // risk cron-job.org's external kill terminating this invocation
      // before the `finally` block below ever gets to release the lock.
      if (timeIsUp()) {
        result.details.push({ email: "", outcome: "stopped early: approaching the tick's soft time deadline" });
        break;
      }

      result.attempted++;

      // Consumer mailbox providers are exempt -- see
      // CONSUMER_MAILBOX_DOMAINS above for why the one-per-tick rule
      // protects nothing on gmail.com and costs most of the day's capacity.
      const capsApplyToDomain = !CONSUMER_MAILBOX_DOMAINS.has(member.recipient_domain);

      if (capsApplyToDomain && domainsSentThisTick.has(member.recipient_domain)) {
        result.skippedDomainCap++;
        result.details.push({ email: member.email, outcome: "skipped: domain already sent this tick" });
        continue;
      }

      const subject = resolveTemplate(member.subject, member);
      const body = resolveTemplate(member.body, member);
      const unresolved = [...findUnresolvedTokens(subject), ...findUnresolvedTokens(body)];
      if (unresolved.length > 0) {
        result.skippedUnresolvedTemplate++;
        result.details.push({ email: member.email, outcome: `skipped: unresolved tokens ${unresolved.join(", ")}` });
        continue;
      }

      // Every prior successful send for this member, oldest first.
      // status='sent' excludes failed attempts (a failed attempt followed
      // by a successful retry would otherwise appear twice, in the wrong
      // relative order for a chain that's supposed to be oldest-to-newest).
      // Only needed for follow-up steps, but harmless (empty) for step 1.
      let chain: NonNullable<Awaited<ReturnType<typeof fetchPriorSends>>["data"]> = [];
      if (member.next_step > 1) {
        const { data: priorSends, error: priorSendsError } = await fetchPriorSends(supabase, member);

        // A transient failure here must not fall through to sending with a
        // blank subject and no reply threading — skip this member for this
        // tick and retry next time rather than send something broken.
        if (priorSendsError) {
          result.skippedQueryError++;
          result.details.push({
            email: member.email,
            outcome: `skipped: could not load prior sends (${priorSendsError.message})`,
          });
          continue;
        }
        chain = priorSends ?? [];
      }

      // A follow-up step always sends from whichever account sent this
      // member's most recent prior step — never re-picked via round robin
      // — so a recipient's whole sequence comes from one address and
      // actually threads together, instead of a different "person"
      // following up each time. Round robin only spreads first-touch
      // volume across accounts; only a member's very first step goes
      // through it.
      const pinnedAccountId = chain.length > 0 ? chain[chain.length - 1].connected_account_id : null;
      let picked: { account: SendAccount; nextCursor: number } | null;
      if (pinnedAccountId) {
        const pinnedAccount = accounts.find((a) => a.id === pinnedAccountId);
        if (!pinnedAccount) {
          result.skippedNoCapacity++;
          result.details.push({
            email: member.email,
            outcome: "skipped: this contact's sending account is no longer active",
          });
          continue;
        }
        const sentSoFar = sentCounts.get(pinnedAccount.id) ?? 0;
        if (sentSoFar >= effectiveCap(pinnedAccount, today)) {
          result.skippedNoCapacity++;
          result.details.push({
            email: member.email,
            outcome: "skipped: this contact's sending account is at its daily cap",
          });
          continue;
        }
        // Doesn't consume a round-robin turn — that rotation is only for
        // spreading first-touch volume across accounts.
        picked = { account: pinnedAccount, nextCursor: cursor };
      } else {
        picked = pickNextAccount(accounts, cursor, sentCounts, today);
        if (!picked) {
          result.skippedNoCapacity++;
          result.details.push({ email: member.email, outcome: "skipped: all accounts at daily cap" });
          continue;
        }
      }

      if (opts.dryRun) {
        cursor = picked.nextCursor;
        sentCounts.set(picked.account.id, (sentCounts.get(picked.account.id) ?? 0) + 1);
        if (capsApplyToDomain) domainsSentThisTick.add(member.recipient_domain);
        result.sent++;
        result.details.push({ email: member.email, outcome: "would send", account: picked.account.email_address });
        continue;
      }

      // Rewrites this step's own links (e.g. each artist's page) to
      // click-tracking redirects — but only this step's, not the quoted
      // step-1 body buildFollowUpContent pulls in below, which was already
      // rewritten with its own tokens back when step 1 itself was sent.
      const trackedBody = await injectClickTracking(supabase, body, {
        contactId: member.contact_id,
        campaignId: member.campaign_id,
        stepNumber: member.next_step,
      });

      // Follow-up steps (2+) default their subject to "Re: [step 1's
      // subject]" when left blank, and always get step 1's original email
      // quoted underneath — always step 1 specifically, never the
      // immediately preceding step, so a long-running sequence doesn't
      // pile up nested quotes. References is still the full, RFC
      // 5322-correct ancestor chain regardless of which step is shown.
      const { finalSubject, finalBody, htmlInner, inReplyTo, references, threadId } = buildFollowUpContent({
        subject,
        body: trackedBody,
        nextStep: member.next_step,
        chain,
        currentAccountId: picked.account.id,
        timezone: settings.send_window?.timezone,
      });

      const trackingToken = randomBytes(8).toString("hex");
      const rfcMessageId = `<${randomUUID()}@${picked.account.email_address.split("@")[1]}>`;
      const finalHtml = wrapEmailHtml(htmlInner);

      try {
        const accessToken = await getAccessToken(supabase, picked.account.id);
        const sendResult = await sendGmailMessage(accessToken, {
          from: formatFromAddress(picked.account.display_name, picked.account.email_address),
          to: member.email,
          subject: finalSubject,
          // The tracking token is a fallback for matching a reply back to
          // this send (see matching.ts tier 2) when a client doesn't echo
          // Message-ID/In-Reply-To. It lives ONLY inside a real HTML
          // comment, which is genuinely invisible in any HTML-rendering
          // client — never in the plain-text part, where there's no such
          // thing as an invisible comment and it would show as literal,
          // suspicious-looking text to the recipient.
          body: finalBody,
          html: `${finalHtml}\n<!-- ${trackingToken} -->`,
          replyTo: replyToEmail,
          messageId: rfcMessageId,
          inReplyTo,
          references,
          threadId,
        });

        await supabase.from("outbound_sends").insert({
          campaign_member_id: member.campaign_member_id,
          campaign_id: member.campaign_id,
          contact_id: member.contact_id,
          step_number: member.next_step,
          connected_account_id: picked.account.id,
          subject_resolved: finalSubject,
          body_resolved: finalBody,
          gmail_message_id: sendResult.id,
          rfc_message_id: rfcMessageId,
          gmail_thread_id: sendResult.threadId,
          tracking_token: trackingToken,
          sent_at: new Date().toISOString(),
          status: "sent",
        });

        await supabase
          .from("campaign_members")
          .update({
            current_step: member.next_step,
            last_sent_at: new Date().toISOString(),
            last_sent_from_account_id: picked.account.id,
            consecutive_failures: 0,
          })
          .eq("id", member.campaign_member_id);

        // Atomic DB-side increment (see migration 00000000000026) rather
        // than upserting a value computed from the in-memory snapshot --
        // that pattern silently lost real sends whenever the snapshot fell
        // behind reality. The returned count is authoritative, so it
        // replaces (not just increments) the local map entry.
        const { data: newCount } = await supabase.rpc("increment_send_counter", {
          p_account_id: picked.account.id,
          p_date: todayDate,
        });
        sentCounts.set(picked.account.id, newCount ?? (sentCounts.get(picked.account.id) ?? 0) + 1);

        cursor = picked.nextCursor;
        if (capsApplyToDomain) domainsSentThisTick.add(member.recipient_domain);
        result.sent++;
        result.details.push({ email: member.email, outcome: "sent", account: picked.account.email_address });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        result.failed++;
        result.details.push({ email: member.email, outcome: `failed: ${message}` });

        // A send is the other place (besides the reply poll) that can
        // discover a dead token first -- mark the account down here too
        // so the next tick's account query stops picking it, rather than
        // waiting on reply-poll-tick to notice separately.
        if (err instanceof OAuthTokenRevokedError) {
          await supabase
            .from("connected_accounts")
            .update({ status: "error", last_error: message })
            .eq("id", picked.account.id);
        }

        await supabase.from("outbound_sends").insert({
          campaign_member_id: member.campaign_member_id,
          campaign_id: member.campaign_id,
          contact_id: member.contact_id,
          step_number: member.next_step,
          connected_account_id: picked.account.id,
          subject_resolved: finalSubject,
          body_resolved: finalBody,
          rfc_message_id: rfcMessageId,
          tracking_token: trackingToken,
          status: "failed",
          error_message: message,
        });

        const { data: memberRow } = await supabase
          .from("campaign_members")
          .select("consecutive_failures")
          .eq("id", member.campaign_member_id)
          .single();
        const failures = (memberRow?.consecutive_failures ?? 0) + 1;
        await supabase
          .from("campaign_members")
          .update({
            consecutive_failures: failures,
            member_status: failures >= 3 ? "paused" : "active",
          })
          .eq("id", member.campaign_member_id);

        cursor = picked.nextCursor;
      }
    }

    if (!opts.dryRun) {
      await supabase.from("app_settings").update({ value: cursor }).eq("key", "round_robin_cursor");
    }

    return result;
  } finally {
    if (!opts.dryRun) {
      await supabase.rpc("release_send_lock");
    }
  }
}
