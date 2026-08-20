"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type FailedLocation = {
  id: string;
  city: string;
  state: string | null;
  country: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
};

export function BackfillRunner({ pendingCount }: { pendingCount: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; remaining: number } | null>(null);

  async function runUntilDone() {
    setRunning(true);
    let remaining = pendingCount;
    let done = 0;
    while (remaining > 0) {
      const res = await fetch("/api/geocode/tick", { method: "POST" });
      if (!res.ok) break;
      const data = await res.json();
      done += data.processed;
      remaining = data.remainingPending;
      setProgress({ done, remaining });
      if (data.processed === 0) break; // nothing left to do or all pending exhausted
    }
    setRunning(false);
    router.refresh();
  }

  return (
    <div className="mt-5 flex items-center gap-3.5">
      <button
        onClick={runUntilDone}
        disabled={running || pendingCount === 0}
        className="rounded-[2px] bg-ink px-4 py-2.5 text-sm font-semibold text-surface disabled:opacity-50"
      >
        {running ? "Running…" : "Run backfill now"}
      </button>
      {progress && (
        <span className="text-sm text-muted-2">
          {progress.done} processed, {progress.remaining} remaining
        </span>
      )}
      {pendingCount === 0 && !running && <span className="text-sm text-muted-3">Nothing pending.</span>}
    </div>
  );
}

export function ManualOverrideList({ locations }: { locations: FailedLocation[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, { lat: string; lng: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  async function save(id: string) {
    const v = values[id];
    if (!v) return;
    setSavingId(id);
    await fetch("/api/geocode/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, lat: parseFloat(v.lat), lng: parseFloat(v.lng) }),
    });
    setSavingId(null);
    router.refresh();
  }

  if (locations.length === 0) {
    return <p className="mt-4 text-sm text-muted-3">No failed or unmatched locations.</p>;
  }

  return (
    <div className="mt-4">
      <div className="grid grid-cols-[1.6fr_0.8fr_0.8fr_1fr_1fr_0.6fr] border-b border-hairline-strong py-2 text-[10px] tracking-wide text-faint uppercase">
        <span>Location</span>
        <span>Status</span>
        <span>Attempts</span>
        <span>Lat</span>
        <span>Lng</span>
        <span></span>
      </div>
      {locations.map((loc) => (
        <div
          key={loc.id}
          className="grid grid-cols-[1.6fr_0.8fr_0.8fr_1fr_1fr_0.6fr] items-center border-b border-hairline-soft py-2.5 text-[13px]"
        >
          <span className="text-ink">{[loc.city, loc.state, loc.country].filter(Boolean).join(", ")}</span>
          <span className="text-error">{loc.status}</span>
          <span className="text-faint-2">{loc.attempts}</span>
          <input
            type="number"
            step="any"
            placeholder="lat"
            value={values[loc.id]?.lat ?? ""}
            onChange={(e) =>
              setValues((s) => ({ ...s, [loc.id]: { ...s[loc.id], lat: e.target.value, lng: s[loc.id]?.lng ?? "" } }))
            }
            className="w-20 border-0 border-b border-rule bg-transparent px-0.5 py-1 text-ink outline-none"
          />
          <input
            type="number"
            step="any"
            placeholder="lng"
            value={values[loc.id]?.lng ?? ""}
            onChange={(e) =>
              setValues((s) => ({ ...s, [loc.id]: { ...s[loc.id], lng: e.target.value, lat: s[loc.id]?.lat ?? "" } }))
            }
            className="w-20 border-0 border-b border-rule bg-transparent px-0.5 py-1 text-ink outline-none"
          />
          <button
            onClick={() => save(loc.id)}
            disabled={savingId === loc.id || !values[loc.id]?.lat || !values[loc.id]?.lng}
            className="justify-self-start rounded-[2px] bg-neutral-badge-bg px-2.5 py-1 text-xs text-ink-soft disabled:opacity-50"
          >
            {savingId === loc.id ? "Saving…" : "Save"}
          </button>
        </div>
      ))}
    </div>
  );
}
