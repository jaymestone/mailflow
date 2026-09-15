import { createClient } from "@/lib/supabase/server";
import { DeliverabilityCheck } from "./health-client";

const EXPECTED_INTERVAL_MINUTES: Record<string, number> = {
  "geocode-tick": 1,
  "send-engine-tick": 15,
  "reply-poll-tick": 5,
};

function minutesSince(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / 60000;
}

export default async function HealthPage() {
  const supabase = await createClient();

  const [{ data: cronHealth }, { data: accounts }, { data: recentFailures }, { data: sendLock }, { data: unmatched }] =
    await Promise.all([
      supabase.from("cron_health").select("job_name, last_run_at, last_result"),
      supabase.from("connected_accounts").select("id, email_address, status, last_error"),
      supabase
        .from("outbound_sends")
        .select("id, contact_id, error_message, created_at")
        .eq("status", "failed")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase.from("send_lock").select("locked_at").eq("id", true).maybeSingle(),
      // A reply/bounce that never linked back to a campaign send is
      // invisible everywhere else -- no campaign's Replies tab shows it
      // (that's scoped to matched_campaign_id), so the send engine has no
      // idea the contact ever responded and just keeps going. Surfacing
      // these here is the only way anyone finds out before the next
      // scheduled step fires. See migration 00000000000027 for why
      // in_reply_to/references_header exist -- they're the actual
      // evidence for *why* a given message didn't match.
      supabase
        .from("inbound_messages")
        .select("id, from_email, from_name, subject, message_type, received_at, in_reply_to, references_header")
        .eq("match_method", "unmatched")
        .in("message_type", ["reply", "bounce"])
        .order("received_at", { ascending: false })
        .limit(20),
    ]);

  // Mirrors the 5-minute self-expiry try_acquire_send_lock() itself applies
  // (see the send_lock migration) -- a lock older than that isn't really
  // "held" anymore, the next tick will silently reclaim it on its own.
  const lockMinutesHeld = sendLock?.locked_at ? minutesSince(sendLock.locked_at) : null;
  const lockActuallyHeld = lockMinutesHeld !== null && lockMinutesHeld < 5;

  const domains = [...new Set((accounts ?? []).map((a) => a.email_address.split("@")[1]))];

  return (
    <div>
      <h1 className="font-display text-[32px] font-medium text-ink">System health</h1>
      <p className="mt-2 text-pretty text-sm text-muted">
        Cron heartbeats, account status, and deliverability signals in one place.
      </p>

      <section className="mt-8">
        <h2 className="font-display text-[21px] font-medium text-ink">Background jobs</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-hairline-strong text-[10px] tracking-wide text-faint uppercase">
              <tr>
                <th className="py-2 pr-3">Job</th>
                <th className="py-2 pr-3">Expected interval</th>
                <th className="py-2 pr-3">Last run</th>
                <th className="py-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(EXPECTED_INTERVAL_MINUTES).map(([job, intervalMin]) => {
                const row = (cronHealth ?? []).find((h) => h.job_name === job);
                const lastRun = row ? new Date(row.last_run_at) : null;
                const minutesAgo = row ? minutesSince(row.last_run_at) : null;
                const stale = minutesAgo === null || minutesAgo > intervalMin * 3;
                return (
                  <tr key={job} className="border-b border-hairline-soft">
                    <td className="py-2.5 pr-3 text-ink">{job}</td>
                    <td className="py-2.5 pr-3 text-faint-2">every {intervalMin}m</td>
                    <td className="py-2.5 pr-3 text-muted-2">
                      {lastRun ? `${Math.round(minutesAgo!)}m ago` : "never run"}
                    </td>
                    <td className={`py-2.5 pr-3 text-xs ${stale ? "text-error" : "text-success"}`}>
                      {stale ? "stale" : "healthy"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {(() => {
        // Whenever a reply-poll-tick's saved history checkpoint turns out to
        // be unusable, this used to be completely silent -- a real gap of
        // unprocessed mail went unnoticed for ~2 hours on 2026-09-15 before
        // this existed. A search-based auto-recovery was attempted the same
        // day but caused repeated live timeouts and is TEMPORARILY DISABLED
        // (see reply/tick.ts) pending investigation -- a reset still
        // re-baselines and gets logged here, but the account's own gap
        // (whatever arrived between the old checkpoint and now) is not
        // currently being recovered automatically. Treat any entry here as
        // a signal that account may need a manual look.
        const replyRow = (cronHealth ?? []).find((h) => h.job_name === "reply-poll-tick");
        const resets = (replyRow?.last_result?.historyResets ?? []) as { account: string; recovered: number }[];
        if (resets.length === 0) return null;
        return (
          <section className="mt-9">
            <h2 className="font-display text-[21px] font-medium text-ink">History checkpoint resets</h2>
            <p className="mt-1.5 text-pretty text-sm text-muted">
              The most recent reply check found a saved checkpoint Gmail no longer recognized. Auto-recovery of
              the resulting gap is temporarily disabled (it caused its own timeouts) — these accounts may have
              unprocessed mail from before the reset that&apos;s worth a manual check.
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {resets.map((r, i) => (
                <li key={i} className="text-ink-soft">
                  <span className="text-ink">{r.account}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      <section className="mt-9">
        <h2 className="font-display text-[21px] font-medium text-ink">Send lock</h2>
        <p className="mt-1.5 text-pretty text-sm text-muted">
          Stops two send ticks from running at once. Self-clears after 5 minutes if a tick ever crashes without
          releasing it, so it can&apos;t get stuck holding sending open indefinitely the way it once could.
        </p>
        <p className={`mt-2 text-sm ${lockActuallyHeld ? "text-error" : "text-success"}`}>
          {lockActuallyHeld
            ? `Held — a tick has been running for ${Math.round(lockMinutesHeld!)} minute${Math.round(lockMinutesHeld!) === 1 ? "" : "s"}. Normal if brief; will self-release automatically at 5 minutes either way.`
            : "Free — nothing currently holding it."}
        </p>
      </section>

      <section className="mt-9">
        <h2 className="font-display text-[21px] font-medium text-ink">Connected accounts</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-hairline-strong text-[10px] tracking-wide text-faint uppercase">
              <tr>
                <th className="py-2 pr-3">Address</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last error</th>
              </tr>
            </thead>
            <tbody>
              {(accounts ?? []).map((a) => (
                <tr key={a.id} className="border-b border-hairline-soft">
                  <td className="py-2.5 pr-3 text-ink">{a.email_address}</td>
                  <td className={`py-2.5 pr-3 text-xs ${a.status === "active" ? "text-success" : "text-error"}`}>
                    {a.status}
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-muted-3">{a.last_error ?? "—"}</td>
                </tr>
              ))}
              {(accounts ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="py-6 text-center text-muted-3">
                    No accounts connected yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-9">
        <h2 className="font-display text-[21px] font-medium text-ink">Deliverability (SPF / DMARC)</h2>
        <p className="mt-1.5 text-pretty text-sm text-muted">
          Checked live against each connected account&apos;s sending domain.
        </p>
        <div className="mt-3">
          <DeliverabilityCheck domains={domains} />
        </div>
      </section>

      <section className="mt-9">
        <h2 className="font-display text-[21px] font-medium text-ink">Recent send failures</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-hairline-strong text-[10px] tracking-wide text-faint uppercase">
              <tr>
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Error</th>
              </tr>
            </thead>
            <tbody>
              {(recentFailures ?? []).map((f) => (
                <tr key={f.id} className="border-b border-hairline-soft">
                  <td className="py-2.5 pr-3 text-faint-2">{new Date(f.created_at).toLocaleString()}</td>
                  <td className="py-2.5 pr-3 text-ink-soft">{f.error_message}</td>
                </tr>
              ))}
              {(recentFailures ?? []).length === 0 && (
                <tr>
                  <td colSpan={2} className="py-6 text-center text-muted-3">
                    No failed sends.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-9">
        <h2 className="font-display text-[21px] font-medium text-ink">Unmatched inbound messages</h2>
        <p className="mt-1.5 text-pretty text-sm text-muted">
          A reply or bounce Mailflow couldn&apos;t link back to a campaign send — the send engine has no record this
          contact responded, so a scheduled follow-up step won&apos;t be held back automatically. Worth a manual
          check on whether that contact should be paused. The headers below are what the match was attempted
          against, for diagnosing why it missed.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-hairline-strong text-[10px] tracking-wide text-faint uppercase">
              <tr>
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">From</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Subject</th>
                <th className="py-2 pr-3">In-Reply-To</th>
                <th className="py-2 pr-3">References</th>
              </tr>
            </thead>
            <tbody>
              {(unmatched ?? []).map((m) => (
                <tr key={m.id} className="border-b border-hairline-soft align-top">
                  <td className="py-2.5 pr-3 whitespace-nowrap text-faint-2">
                    {new Date(m.received_at).toLocaleString()}
                  </td>
                  <td className="py-2.5 pr-3 text-ink">
                    {m.from_name ? `${m.from_name} ` : ""}
                    <span className="text-muted-3">{m.from_email}</span>
                  </td>
                  <td className="py-2.5 pr-3 text-muted-2">{m.message_type}</td>
                  <td className="py-2.5 pr-3 text-ink-soft">{m.subject ?? "—"}</td>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-faint-2">{m.in_reply_to ?? "(missing)"}</td>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-faint-2">
                    {m.references_header ?? "(missing)"}
                  </td>
                </tr>
              ))}
              {(unmatched ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-muted-3">
                    Nothing unmatched — every reply and bounce so far has linked back to a real send.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
