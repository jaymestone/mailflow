import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "crypto";
import { pickNextAccount, type SendAccount } from "./roundRobin";
import { findUnresolvedTokens, resolveTemplate } from "@/lib/templates/resolve";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";

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
      .select("id, email_address, ramp_schedule, ramp_started_at")
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

      const picked = pickNextAccount(accounts, cursor, sentCounts, today);
      if (!picked) {
        result.skippedNoCapacity++;
        result.details.push({ email: member.email, outcome: "skipped: all accounts at daily cap" });
        continue;
      }

      if (opts.dryRun) {
        cursor = picked.nextCursor;
        sentCounts.set(picked.account.id, (sentCounts.get(picked.account.id) ?? 0) + 1);
        domainsSentThisTick.add(member.recipient_domain);
        result.sent++;
        result.details.push({ email: member.email, outcome: "would send", account: picked.account.email_address });
        continue;
      }

      const trackingToken = randomBytes(8).toString("hex");
      const rfcMessageId = `<${randomUUID()}@${picked.account.email_address.split("@")[1]}>`;

      try {
        const accessToken = await getAccessToken(supabase, picked.account.id);
        const sendResult = await sendGmailMessage(accessToken, {
          from: picked.account.email_address,
          to: member.email,
          subject,
          body: `${body}\n\n<!-- ${trackingToken} -->`,
          replyTo: replyToEmail,
        });

        await supabase.from("outbound_sends").insert({
          campaign_member_id: member.campaign_member_id,
          campaign_id: member.campaign_id,
          contact_id: member.contact_id,
          step_number: member.next_step,
          connected_account_id: picked.account.id,
          subject_resolved: subject,
          body_resolved: body,
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
          subject_resolved: subject,
          body_resolved: body,
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
