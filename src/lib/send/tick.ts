import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "crypto";
import { effectiveCap, pickNextAccount, type SendAccount } from "./roundRobin";
import { buildFollowUpContent } from "./buildFollowUp";
import { findUnresolvedTokens, resolveTemplate } from "@/lib/templates/resolve";
import { wrapEmailHtml } from "@/lib/templates/emailHtml";
import { formatFromAddress, getAccessToken, sendGmailMessage } from "@/lib/gmail/client";

const DEFAULT_BATCH_LIMIT = 100;

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
  opts: { dryRun?: boolean; ignoreSendWindow?: boolean } = {},
): Promise<SendTickResult> {
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
      .in("key", ["round_robin_cursor", "reply_to_account_id", "send_window"]);
    const settings = Object.fromEntries((settingsRows ?? []).map((r) => [r.key, r.value]));

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
      batch_limit: DEFAULT_BATCH_LIMIT,
    });
    const members: DueMember[] = dueMembers ?? [];

    const domainsSentThisTick = new Set<string>();

    for (const member of members) {
      result.attempted++;

      if (domainsSentThisTick.has(member.recipient_domain)) {
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
        domainsSentThisTick.add(member.recipient_domain);
        result.sent++;
        result.details.push({ email: member.email, outcome: "would send", account: picked.account.email_address });
        continue;
      }

      // Follow-up steps (2+) default their subject to "Re: [step 1's
      // subject]" when left blank, and always get step 1's original email
      // quoted underneath — always step 1 specifically, never the
      // immediately preceding step, so a long-running sequence doesn't
      // pile up nested quotes. References is still the full, RFC
      // 5322-correct ancestor chain regardless of which step is shown.
      const { finalSubject, finalBody, htmlInner, inReplyTo, references, threadId } = buildFollowUpContent({
        subject,
        body,
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

        const newCount = (sentCounts.get(picked.account.id) ?? 0) + 1;
        sentCounts.set(picked.account.id, newCount);
        await supabase
          .from("send_counters")
          .upsert(
            { connected_account_id: picked.account.id, date: todayDate, sent_count: newCount },
            { onConflict: "connected_account_id,date" },
          );

        cursor = picked.nextCursor;
        domainsSentThisTick.add(member.recipient_domain);
        result.sent++;
        result.details.push({ email: member.email, outcome: "sent", account: picked.account.email_address });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        result.failed++;
        result.details.push({ email: member.email, outcome: `failed: ${message}` });

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
