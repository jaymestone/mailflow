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
    <div className="mt-3 rounded-lg border border-neutral-800 p-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => run(true)}
          disabled={busy !== null}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 disabled:opacity-50"
        >
          {busy === "dry" ? "Running…" : "Dry run"}
        </button>
        <button
          onClick={() => run(false)}
          disabled={busy !== null}
          className="rounded-md bg-neutral-50 px-3 py-1.5 text-sm font-medium text-neutral-950 disabled:opacity-50"
        >
          {busy === "live" ? "Sending…" : "Send Now"}
        </button>
        <span className="text-xs text-neutral-500">
          Processes every due campaign across the account (not just this one), respecting the
          round robin, daily caps, and suppression.
        </span>
      </div>

      {result && (
        <div className="mt-3 text-sm">
          <div className="text-neutral-300">
            Attempted {result.attempted} · Sent {result.sent} · Failed {result.failed} · No
            capacity {result.skippedNoCapacity} · Domain cap {result.skippedDomainCap} · Bad
            template {result.skippedUnresolvedTemplate}
          </div>
          <ul className="mt-2 max-h-48 overflow-y-auto text-xs text-neutral-500">
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
