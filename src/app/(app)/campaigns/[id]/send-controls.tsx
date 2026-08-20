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

export function SendControls() {
  const router = useRouter();
  const [busy, setBusy] = useState<"dry" | "live" | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  async function run(dryRun: boolean) {
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

  return (
    <div className="mt-6 rounded-[3px] border border-hairline bg-surface p-[18px_20px]">
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={() => run(true)}
          disabled={busy !== null}
          className="rounded-[2px] bg-neutral-badge-bg px-4 py-2.5 text-xs font-semibold text-ink-soft disabled:opacity-50"
        >
          {busy === "dry" ? "Running…" : "Dry run"}
        </button>
        <button
          onClick={() => run(false)}
          disabled={busy !== null}
          className="rounded-[2px] bg-ink px-4 py-2.5 text-xs font-semibold text-surface disabled:opacity-50"
        >
          {busy === "live" ? "Sending…" : "Send now"}
        </button>
        <span className="text-xs text-muted-3">
          Processes every due campaign account-wide, respecting caps and suppression.
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
