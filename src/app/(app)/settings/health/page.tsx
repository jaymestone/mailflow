import { createClient } from "@/lib/supabase/server";
import { DeliverabilityCheck } from "./health-client";

const EXPECTED_INTERVAL_MINUTES: Record<string, number> = {
  "geocode-tick": 1,
  "send-engine-tick": 15,
  "reply-poll-tick": 5,
};

export default async function HealthPage() {
  const supabase = await createClient();

  const [{ data: cronHealth }, { data: accounts }, { data: recentFailures }] = await Promise.all([
    supabase.from("cron_health").select("job_name, last_run_at, last_result"),
    supabase.from("connected_accounts").select("id, email_address, status, last_error"),
    supabase
      .from("outbound_sends")
      .select("id, contact_id, error_message, created_at")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

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
                const minutesAgo = lastRun ? (Date.now() - lastRun.getTime()) / 60000 : null;
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
    </div>
  );
}
