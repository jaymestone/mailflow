import { createClient } from "@/lib/supabase/server";
import { DeliverabilityCheck } from "./health-client";
import { ReprocessControls } from "./reprocess-controls";
import { EXPECTED_INTERVAL_MINUTES } from "@/lib/health/constants";
import { DAILY_COUNT_KEY, DAILY_RESEARCH_CAP } from "@/lib/research/replacementTick";

function minutesSince(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / 60000;
}

export default async function HealthPage() {
  const supabase = await createClient();

  const [
    { data: cronHealth },
    { data: accounts },
    { data: recentFailures },
    { data: sendLock },
    { data: unmatched },
    { data: abandonedResearch },
    { count: abandonedResearchTotal },
    { count: pendingResearch },
    { data: researchStatuses },
    { data: researchUsage },
    { count: researchedContactsAlive },
  ] = await Promise.all([
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
      // When a contact hard-bounces or says they've left, the venue itself
      // is usually still a real prospect -- so it goes to the replacement
      // research queue to find whoever took over. When that research gives
      // up, the row is marked and a note explains why, and until now that
      // was the end of it: no screen anywhere showed these, so a venue
      // dropping out of the pipeline was completely silent. 133 had
      // accumulated unseen by 2026-09-22, nearly all of them timeouts
      // rather than genuine dead ends (see findReplacement.ts).
      supabase
        .from("replacement_queue")
        .select("id, venue, city, state, removed_contact_email, removed_reason, notes, researched_at")
        .eq("status", "no_replacement_found")
        .order("researched_at", { ascending: false })
        .limit(25),
      supabase
        .from("replacement_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "no_replacement_found"),
      supabase
        .from("replacement_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      // Outcome mix for the research, so its hit rate is visible rather
      // than inferred. Grouped in JS rather than with four head-counts --
      // the queue is small and this is one round trip instead of four.
      supabase.from("replacement_queue").select("status").limit(2000),
      supabase.from("app_settings").select("value").eq("key", DAILY_COUNT_KEY).maybeSingle(),
      // Every contact the research produced is stamped with this source,
      // which is what makes its output traceable after the fact.
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .like("source", "Auto-replacement%"),
    ]);

  // Mirrors the 5-minute self-expiry try_acquire_send_lock() itself applies
  // (see the send_lock migration) -- a lock older than that isn't really
  // "held" anymore, the next tick will silently reclaim it on its own.
  const lockMinutesHeld = sendLock?.locked_at ? minutesSince(sendLock.locked_at) : null;
  const lockActuallyHeld = lockMinutesHeld !== null && lockMinutesHeld < 5;

  const domains = [...new Set((accounts ?? []).map((a) => a.email_address.split("@")[1]))];

  // --- Replacement research: is it worth what it costs? ---------------
  // The benchmark is Jayme's VA at $0.15 a contact with roughly 75% of
  // them usable, i.e. about $0.20 per contact he can actually rely on.
  // Answering that needs two things this page can supply -- how often the
  // research succeeds, and how often what it found turns out to be real.
  const statusCounts = (researchStatuses ?? []).reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const replacedCount = statusCounts.replaced ?? 0;
  const noReplacementCount = statusCounts.no_replacement_found ?? 0;
  const completedSearches = replacedCount + noReplacementCount;
  const hitRate = completedSearches > 0 ? Math.round((replacedCount / completedSearches) * 100) : null;

  // Every contact the research produced carries the "Auto-replacement"
  // source stamp. A hard bounce deletes the contact outright (see
  // reply/tick.ts), so a found address that turned out to be wrong
  // disappears -- which makes the gap between produced and surviving a
  // usable, if imperfect, reliability signal. Imperfect because an
  // opt-out or a later departure removes a contact too, so this reads as
  // a floor on reliability rather than an exact figure.
  const researchedProduced = replacedCount;
  const researchedAlive = researchedContactsAlive ?? 0;
  const researchedGone = Math.max(researchedProduced - researchedAlive, 0);
  const survivalRate = researchedProduced > 0 ? Math.round((researchedAlive / researchedProduced) * 100) : null;

  const usage = researchUsage?.value as { date?: string; count?: number } | null | undefined;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const usedToday = usage && usage.date === todayUtc ? (usage.count ?? 0) : 0;

  return (
    <div>
      <h1 className="font-display text-[32px] font-medium text-ink">System health</h1>
      <p className="mt-2 text-pretty text-sm text-muted">
        Cron heartbeats, account status, and deliverability signals in one place.
      </p>

      {(abandonedResearchTotal ?? 0) > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-[21px] font-medium text-ink">Venues needing a replacement contact</h2>
          <p className="mt-1.5 text-pretty text-sm text-muted">
            These venues lost their contact (a hard bounce, or they said they&apos;d left) and automated research
            couldn&apos;t find a replacement, so nothing further will happen with them on its own. The venue is
            usually still a real prospect — finding someone new there is a manual job.
            {(pendingResearch ?? 0) > 0 && (
              <>
                {" "}
                {pendingResearch} more {pendingResearch === 1 ? "is" : "are"} still queued for research.
              </>
            )}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-hairline-strong text-[10px] tracking-wide text-faint uppercase">
                <tr>
                  <th className="py-2 pr-3">Venue</th>
                  <th className="py-2 pr-3">Where</th>
                  <th className="py-2 pr-3">Lost contact</th>
                  <th className="py-2 pr-3">Why research stopped</th>
                </tr>
              </thead>
              <tbody>
                {(abandonedResearch ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-hairline-soft align-top">
                    <td className="py-2.5 pr-3 text-ink">{r.venue ?? "—"}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-2">
                      {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-3">
                      {r.removed_contact_email}
                      <span className="text-faint-2"> ({r.removed_reason})</span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted-3">{r.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(abandonedResearchTotal ?? 0) > (abandonedResearch ?? []).length && (
            <p className="mt-2 text-xs text-faint-2">
              Showing the {(abandonedResearch ?? []).length} most recent of {abandonedResearchTotal}.
            </p>
          )}
        </section>
      )}

      <section className="mt-9">
        <h2 className="font-display text-[21px] font-medium text-ink">Replacement research — is it earning its keep?</h2>
        <p className="mt-1.5 text-pretty text-sm text-muted">
          For comparison: a VA at $0.15 a contact with ~75% usable works out to about{" "}
          <span className="text-ink">$0.20 per contact you can rely on</span>. The two numbers that decide whether
          this beats that are how often the search succeeds, and how much of what it finds turns out to be real.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-[3px] border border-hairline bg-surface p-[14px_16px]">
            <div className="text-[10px] tracking-wide text-faint uppercase">Hit rate</div>
            <div className="mt-1 font-display text-[26px] text-ink">
              {hitRate === null ? "—" : `${hitRate}%`}
            </div>
            <div className="mt-0.5 text-xs text-muted-3">
              {completedSearches === 0
                ? "no completed searches yet"
                : `${replacedCount} found / ${completedSearches} searched`}
            </div>
          </div>

          <div className="rounded-[3px] border border-hairline bg-surface p-[14px_16px]">
            <div className="text-[10px] tracking-wide text-faint uppercase">Still valid</div>
            <div className="mt-1 font-display text-[26px] text-ink">
              {survivalRate === null ? "—" : `${survivalRate}%`}
            </div>
            <div className="mt-0.5 text-xs text-muted-3">
              {researchedProduced === 0
                ? "none produced yet"
                : `${researchedAlive} of ${researchedProduced} still active${researchedGone > 0 ? `, ${researchedGone} since removed` : ""}`}
            </div>
          </div>

          <div className="rounded-[3px] border border-hairline bg-surface p-[14px_16px]">
            <div className="text-[10px] tracking-wide text-faint uppercase">Today&apos;s searches</div>
            <div className="mt-1 font-display text-[26px] text-ink">
              {usedToday}
              <span className="text-[15px] text-faint-2"> / {DAILY_RESEARCH_CAP}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-3">
              {usedToday >= DAILY_RESEARCH_CAP ? "daily cap reached — resumes tomorrow" : "daily spending cap"}
            </div>
          </div>
        </div>

        <p className="mt-3 text-pretty text-xs text-faint-2">
          &ldquo;Still valid&rdquo; is a floor, not an exact figure. A researched address that turns out to be wrong
          hard-bounces, and a hard bounce deletes the contact — so the gap between found and still-active is mostly
          bad addresses, but an opt-out or a later departure removes a contact too. Read it as
          &ldquo;at least this reliable.&rdquo;
          {(pendingResearch ?? 0) > 0 && (
            <>
              {" "}
              {pendingResearch} venue{pendingResearch === 1 ? "" : "s"} still queued
              {usedToday >= DAILY_RESEARCH_CAP ? "; today's cap is spent" : ""}.
            </>
          )}
        </p>
      </section>

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
        // this existed. Search-based auto-recovery (re-enabled 2026-09-16,
        // see reply/tick.ts) now runs automatically on a reset -- `recovered`
        // is how many messages it actually found and processed from the
        // gap. Still worth a glance: the recovery search only looks back a
        // few days, so a reset after a much longer gap may need a manual
        // check via "Reprocess stuck messages" below with a wider window.
        const replyRow = (cronHealth ?? []).find((h) => h.job_name === "reply-poll-tick");
        const resets = (replyRow?.last_result?.historyResets ?? []) as { account: string; recovered: number }[];
        if (resets.length === 0) return null;
        return (
          <section className="mt-9">
            <h2 className="font-display text-[21px] font-medium text-ink">History checkpoint resets</h2>
            <p className="mt-1.5 text-pretty text-sm text-muted">
              The most recent reply check found a saved checkpoint Gmail no longer recognized, and automatically
              searched for anything from the gap.
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {resets.map((r, i) => (
                <li key={i} className="text-ink-soft">
                  <span className="text-ink">{r.account}</span> — {r.recovered} recovered
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
        <h2 className="font-display text-[21px] font-medium text-ink">Reprocess stuck messages</h2>
        <ReprocessControls />
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
