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
      <h1 className="text-balance text-2xl font-semibold">System health</h1>
      <p className="mt-2 text-pretty text-sm text-neutral-400">
        Cron heartbeats, account status, and deliverability signals in one place.
      </p>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Background jobs</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Expected interval</th>
                <th className="px-3 py-2">Last run</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(EXPECTED_INTERVAL_MINUTES).map(([job, intervalMin]) => {
                const row = (cronHealth ?? []).find((h) => h.job_name === job);
                const lastRun = row ? new Date(row.last_run_at) : null;
                const minutesAgo = lastRun ? (Date.now() - lastRun.getTime()) / 60000 : null;
                const stale = minutesAgo === null || minutesAgo > intervalMin * 3;
                return (
                  <tr key={job} className="border-b border-neutral-900">
                    <td className="px-3 py-2 text-neutral-100">{job}</td>
                    <td className="px-3 py-2 text-neutral-500">every {intervalMin}m</td>
                    <td className="px-3 py-2 text-neutral-400">
                      {lastRun ? `${Math.round(minutesAgo!)}m ago` : "never run"}
                    </td>
                    <td className={`px-3 py-2 text-xs ${stale ? "text-red-400" : "text-emerald-400"}`}>
                      {stale ? "stale" : "healthy"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Connected accounts</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last error</th>
              </tr>
            </thead>
            <tbody>
              {(accounts ?? []).map((a) => (
                <tr key={a.id} className="border-b border-neutral-900">
                  <td className="px-3 py-2 text-neutral-100">{a.email_address}</td>
                  <td className={`px-3 py-2 text-xs ${a.status === "active" ? "text-emerald-400" : "text-red-400"}`}>
                    {a.status}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-500">{a.last_error ?? "—"}</td>
                </tr>
              ))}
              {(accounts ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-neutral-500">
                    No accounts connected yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Deliverability (SPF / DMARC)</h2>
        <p className="mt-1 text-pretty text-sm text-neutral-400">
          Checked live against each connected account&apos;s sending domain.
        </p>
        <div className="mt-3">
          <DeliverabilityCheck domains={domains} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Recent send failures</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {(recentFailures ?? []).map((f) => (
                <tr key={f.id} className="border-b border-neutral-900">
                  <td className="px-3 py-2 text-neutral-500">{new Date(f.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-neutral-300">{f.error_message}</td>
                </tr>
              ))}
              {(recentFailures ?? []).length === 0 && (
                <tr>
                  <td colSpan={2} className="px-3 py-6 text-center text-neutral-500">
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
