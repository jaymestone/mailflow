"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SendResult = {
  attempted: number;
  sent: number;
  failed: number;
  skippedNoCapacity: number;
  skippedDomainCap: number;
  skippedUnresolvedTemplate: number;
  details: { email: string; outcome: string; account?: string }[];
};

/** `lastEngineRunAt` is the send engine's own cron_health heartbeat (the
 * same tick this triggers manually) -- shown so it's obvious sending
 * already happens automatically on its own schedule, without needing this
 * button. Without that context, an always-clickable "Send now" sitting on
 * every campaign's page reads as "you need to press this," and gives no
 * way to tell whether a large, already-active campaign is actually still
 * progressing on its own or has stalled. */
export function SendControls({ lastEngineRunAt }: { lastEngineRunAt: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"dry" | "live" | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  async function run(dryRun: boolean) {
    if (!dryRun && !confirm("Send now? This processes every due campaign account-wide and sends real email.")) {
      return;
    }
    setBusy(dryRun ? "dry" : "live");
    setResult(null);
    const res = await fetch("/api/send/tick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun }),
    });
    const data = await res.json();
    setBusy(null);
    setResult(data);
    if (!dryRun) router.refresh();
  }

  const minutesSinceLastRun = lastEngineRunAt
    ? Math.round((Date.now() - new Date(lastEngineRunAt).getTime()) / 60000)
    : null;
  // The tick is expected roughly every 15 minutes -- well past that (a
  // generous 2x margin, since cron-job.org occasionally runs a few minutes
  // late) is a real signal something's stuck, not sending on its own
  // schedule anymore. This is the direct answer to "is it actually still
  // going" for a large campaign nobody's watching minute to minute.
  const isStale = minutesSinceLastRun !== null && minutesSinceLastRun > 30;

  return (
    <div className="mt-6 rounded-[3px] border border-hairline bg-surface p-[18px_20px]">
      <p className="text-xs text-ink-soft">
        {lastEngineRunAt ? (
          isStale ? (
            <>
              <span className="text-error">●</span> The send engine hasn&apos;t run in{" "}
              <RelativeTime iso={lastEngineRunAt} /> — normally it checks every ~15 minutes, so this may be stuck.
              Worth checking{" "}
              <a href="/settings/health" className="text-accent underline">
                Health
              </a>
              .
            </>
          ) : (
            <>
              <span className="text-success">●</span> Sending automatically, account-wide — engine last ran{" "}
              <RelativeTime iso={lastEngineRunAt} />, and checks again roughly every 15 minutes. Nothing below is
              required for an already-active campaign to keep going.
            </>
          )
        ) : (
          "Sending automatically, account-wide, roughly every 15 minutes. Nothing below is required for an already-active campaign to keep going."
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <button
          onClick={() => run(true)}
          disabled={busy !== null}
          className="rounded-[2px] border border-hairline px-4 py-2 text-xs font-semibold text-muted-2 disabled:opacity-50"
        >
          {busy === "dry" ? "Running…" : "Dry run"}
        </button>
        <button
          onClick={() => run(false)}
          disabled={busy !== null}
          className="rounded-[2px] border border-hairline px-4 py-2 text-xs font-semibold text-muted-2 disabled:opacity-50"
        >
          {busy === "live" ? "Sending…" : "Send now anyway"}
        </button>
        <span className="text-xs text-faint-3">
          Manually triggers a tick early, for every due campaign account-wide (not just this one) — mainly useful
          for testing, not normal operation.
        </span>
      </div>

      {result && (
        <div className="mt-4 text-sm">
          <div className="text-ink-soft">
            Attempted {result.attempted} · Sent {result.sent} · Failed {result.failed} · No
            capacity {result.skippedNoCapacity} · Domain cap {result.skippedDomainCap} · Bad
            template {result.skippedUnresolvedTemplate}
          </div>
          <ul className="mt-2 max-h-48 overflow-y-auto text-xs text-faint">
            {result.details.map((d, i) => (
              <li key={i}>
                {d.email || "(tick)"} — {d.outcome}
                {d.account && ` via ${d.account}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  const minutesAgo = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutesAgo === 0) return <>less than a minute ago</>;
  if (minutesAgo === 1) return <>1 minute ago</>;
  if (minutesAgo < 60) return <>{minutesAgo} minutes ago</>;
  const hoursAgo = Math.round(minutesAgo / 60);
  return <>{hoursAgo} hour{hoursAgo === 1 ? "" : "s"} ago</>;
}
