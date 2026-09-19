import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatFromAddress, getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { EXPECTED_INTERVAL_MINUTES } from "./constants";

// Same address the account-recovery reporting in this conversation went
// to -- the one person actually running this system day to day.
const ALERT_RECIPIENT = "jayme@jaymestone.com";

// Once a given problem has been reported, don't repeat it every time this
// job runs (every 15 minutes would otherwise mean 4 emails/hour for one
// still-unresolved issue) -- but do re-report it if it's still unhealthy
// after this long, since silence for days on a real problem is exactly
// the failure mode this exists to close.
const ALERT_COOLDOWN_HOURS = 4;

// A message that's still missing its label this long after being
// classified is the exact signature of the two incidents this alerting
// was built in response to (2026-09-16): the label-retry aging-out gap,
// and the more severe checkpoint-skip bug where a message was never
// recorded at all. A couple of minutes' lag during a normal tick is
// routine; two hours is not.
const UNLABELED_BACKLOG_AGE_HOURS = 2;

// Deliberately 1, not a "spike" count: a single contact still being
// sequenced after they already replied is itself worth knowing about, and
// because this now only counts that specific case (see the check below),
// it should normally be zero rather than something that needs a threshold
// to stay quiet.
const UNMATCHED_ACTIVE_CONTACT_THRESHOLD = 1;
const UNMATCHED_SPIKE_WINDOW_HOURS = 24;
const SEND_FAILURE_SPIKE_THRESHOLD = 3;
const SEND_FAILURE_SPIKE_WINDOW_HOURS = 24;

type Signal = { key: string; message: string };

export type AlertCheckResult = {
  /** Every currently-unhealthy signal, whether or not it was actually
   * emailed this run (some may still be within their cooldown). */
  unhealthySignals: string[];
  sentEmail: boolean;
  skippedByCooldown: string[];
};

/** Read-only: computes every currently-unhealthy signal, mirroring what
 * the Health page (src/app/(app)/settings/health/page.tsx) already
 * surfaces for a human to read -- this is the same data, just evaluated
 * against a threshold so it can decide for itself whether to page
 * someone, instead of waiting for a person to go look. */
async function gatherSignals(supabase: SupabaseClient): Promise<Signal[]> {
  const signals: Signal[] = [];
  const now = Date.now();

  const { data: cronHealth } = await supabase.from("cron_health").select("job_name, last_run_at, last_result");

  for (const [job, intervalMin] of Object.entries(EXPECTED_INTERVAL_MINUTES)) {
    const row = (cronHealth ?? []).find((h: { job_name: string }) => h.job_name === job);
    const minutesAgo = row ? (now - new Date(row.last_run_at).getTime()) / 60000 : null;
    const stale = minutesAgo === null || minutesAgo > intervalMin * 3;
    if (stale) {
      signals.push({
        key: `stale-cron:${job}`,
        message: row
          ? `"${job}" hasn't run in ${Math.round(minutesAgo!)} minutes (expected every ${intervalMin}m) -- it may be crashing or the external cron trigger may have stopped firing.`
          : `"${job}" has never recorded a run.`,
      });
    }
  }

  // Same signal the Health page's "History checkpoint resets" section
  // reads from -- a reset whose gap isn't being auto-recovered (that path
  // is currently disabled, see reply/tick.ts) is exactly the kind of thing
  // that otherwise sits invisible until someone happens to check.
  const replyRow = (cronHealth ?? []).find((h: { job_name: string }) => h.job_name === "reply-poll-tick");
  const resets = (replyRow?.last_result as { historyResets?: { account: string }[] } | undefined)?.historyResets ?? [];
  for (const r of resets) {
    signals.push({
      key: `history-reset:${r.account}`,
      message: `${r.account}'s reply-poll checkpoint was reset by Gmail -- auto-recovery of the gap is currently disabled, so mail from before the reset may need a manual check.`,
    });
  }

  const { data: errorAccounts } = await supabase.from("connected_accounts").select("email_address, last_error").eq("status", "error");
  for (const a of errorAccounts ?? []) {
    signals.push({ key: `account-error:${a.email_address}`, message: `${a.email_address} needs reconnecting -- ${a.last_error ?? "unknown error"}.` });
  }

  const unlabeledCutoff = new Date(now - UNLABELED_BACKLOG_AGE_HOURS * 60 * 60 * 1000).toISOString();
  const { count: unlabeledCount } = await supabase
    .from("inbound_messages")
    .select("id", { count: "exact", head: true })
    .not("classification_category", "is", null)
    .is("label_applied_at", null)
    .lt("classified_at", unlabeledCutoff);
  if ((unlabeledCount ?? 0) > 0) {
    signals.push({
      key: "unlabeled-backlog",
      message: `${unlabeledCount} message(s) were classified more than ${UNLABELED_BACKLOG_AGE_HOURS}h ago but never got their Gmail label applied.`,
    });
  }

  // Deliberately NOT "how many messages were unmatched" -- that was the
  // original check, and at real volume it fired constantly on nothing
  // actionable (confirmed live, 2026-09-19: 91 unmatched in 24h, of which
  // zero belonged to a contact still active in a campaign; Jayme was
  // getting several alert emails a day, all of them noise). Plenty of
  // inbound mail legitimately can't be tied to one send -- someone
  // replying from a personal alias, a colleague answering on their
  // behalf, a secondary DSN -- and none of that needs a human.
  //
  // The case that actually matters is narrower: an unmatched message
  // whose sender IS a real contact who is STILL ACTIVE in a campaign.
  // That's the one shape where the sequence keeps running at someone who
  // already responded, which is exactly what nobody would otherwise
  // notice. Checked by resolving senders to contacts rather than counting
  // raw messages, so this stays silent on ordinary volume and gets loud
  // only when someone is genuinely about to be emailed past a reply.
  const unmatchedCutoff = new Date(now - UNMATCHED_SPIKE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { data: unmatchedRows } = await supabase
    .from("inbound_messages")
    .select("from_email")
    .eq("match_method", "unmatched")
    .in("message_type", ["reply", "bounce"])
    .gte("received_at", unmatchedCutoff)
    .limit(1000);
  const senderEmails = [...new Set((unmatchedRows ?? []).map((r: { from_email: string }) => r.from_email.toLowerCase()))];
  const stillActive: string[] = [];
  for (const email of senderEmails) {
    const { data: contact } = await supabase.from("contacts").select("id").ilike("email", email).maybeSingle();
    if (!contact) continue;
    const { data: activeMember } = await supabase
      .from("campaign_members")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("member_status", "active")
      .limit(1)
      .maybeSingle();
    if (activeMember) stillActive.push(email);
  }
  if (stillActive.length >= UNMATCHED_ACTIVE_CONTACT_THRESHOLD) {
    const shown = stillActive.slice(0, 5).join(", ");
    const more = stillActive.length > 5 ? `, and ${stillActive.length - 5} more` : "";
    signals.push({
      key: "unmatched-active-contact",
      message: `${stillActive.length} contact(s) replied or bounced in the last ${UNMATCHED_SPIKE_WINDOW_HOURS}h but are STILL ACTIVE in a campaign -- their sequence will keep sending unless someone intervenes: ${shown}${more}.`,
    });
  }

  const failureCutoff = new Date(now - SEND_FAILURE_SPIKE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { count: failureCount } = await supabase
    .from("outbound_sends")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("created_at", failureCutoff);
  if ((failureCount ?? 0) >= SEND_FAILURE_SPIKE_THRESHOLD) {
    signals.push({
      key: "send-failure-spike",
      message: `${failureCount} sends failed in the last ${SEND_FAILURE_SPIKE_WINDOW_HOURS}h.`,
    });
  }

  return signals;
}

/** Computes every unhealthy signal and, for whichever ones are outside
 * their cooldown, emails one combined summary to Jayme rather than
 * requiring him to go check the Health page himself. Intentionally does
 * NOT attempt to fix anything -- see the reprocess-backlog admin action
 * for the automatic-recovery half of this; this is purely the "don't make
 * a person notice first" half. */
export async function checkAndSendAlerts(supabase: SupabaseClient): Promise<AlertCheckResult> {
  const signals = await gatherSignals(supabase);
  if (signals.length === 0) return { unhealthySignals: [], sentEmail: false, skippedByCooldown: [] };

  const cooldownKeys = signals.map((s) => `alert_cooldown:${s.key}`);
  const { data: cooldownRows } = await supabase.from("app_settings").select("key, value").in("key", cooldownKeys);
  const cooldownByKey = new Map((cooldownRows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value as string]));

  const now = Date.now();
  const due = signals.filter((s) => {
    const last = cooldownByKey.get(`alert_cooldown:${s.key}`);
    if (!last) return true;
    return now - new Date(last).getTime() > ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
  });
  const skippedByCooldown = signals.filter((s) => !due.includes(s)).map((s) => s.key);

  if (due.length === 0) {
    return { unhealthySignals: signals.map((s) => s.key), sentEmail: false, skippedByCooldown };
  }

  // reply_to_account_id is the account already treated as this system's
  // primary identity (see round-robin/reply-to logic in send/tick.ts) --
  // reused here rather than inventing a second notion of "the sending
  // account" just for alerts.
  const { data: settingRow } = await supabase.from("app_settings").select("value").eq("key", "reply_to_account_id").maybeSingle();
  const accountId = settingRow?.value as string | null;
  if (!accountId) return { unhealthySignals: signals.map((s) => s.key), sentEmail: false, skippedByCooldown };

  const { data: account } = await supabase
    .from("connected_accounts")
    .select("id, email_address, display_name")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) return { unhealthySignals: signals.map((s) => s.key), sentEmail: false, skippedByCooldown };

  const accessToken = await getAccessToken(supabase, account.id);
  const body = [
    due.length === 1 ? "Mailflow found something that needs attention:" : `Mailflow found ${due.length} things that need attention:`,
    "",
    ...due.map((s) => `- ${s.message}`),
    "",
    "Check the Health page in Mailflow for details. This won't email again about the same issue for a few hours.",
  ].join("\n");

  await sendGmailMessage(accessToken, {
    from: formatFromAddress(account.display_name ?? null, account.email_address),
    to: ALERT_RECIPIENT,
    subject: due.length === 1 ? "Mailflow: 1 issue needs attention" : `Mailflow: ${due.length} issues need attention`,
    body,
    messageId: `<${randomUUID()}@${account.email_address.split("@")[1]}>`,
  });

  const nowIso = new Date().toISOString();
  for (const s of due) {
    await supabase.from("app_settings").upsert({ key: `alert_cooldown:${s.key}`, value: nowIso }, { onConflict: "key" });
  }

  return { unhealthySignals: signals.map((s) => s.key), sentEmail: true, skippedByCooldown };
}
