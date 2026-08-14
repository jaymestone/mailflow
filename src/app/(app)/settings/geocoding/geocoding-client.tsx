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
    <div className="mt-4 flex items-center gap-3">
      <button
        onClick={runUntilDone}
        disabled={running || pendingCount === 0}
        className="rounded-lg bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
      >
        {running ? "Running…" : "Run backfill now"}
      </button>
      {progress && (
        <span className="text-sm text-neutral-400">
          {progress.done} processed, {progress.remaining} remaining
        </span>
      )}
      {pendingCount === 0 && !running && (
        <span className="text-sm text-neutral-500">Nothing pending.</span>
      )}
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
    return <p className="mt-4 text-sm text-neutral-500">No failed or unmatched locations.</p>;
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
          <tr>
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Attempts</th>
            <th className="px-3 py-2">Lat</th>
            <th className="px-3 py-2">Lng</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {locations.map((loc) => (
            <tr key={loc.id} className="border-b border-neutral-900">
              <td className="px-3 py-2 text-neutral-100">
                {[loc.city, loc.state, loc.country].filter(Boolean).join(", ")}
              </td>
              <td className="px-3 py-2 text-red-400">{loc.status}</td>
              <td className="px-3 py-2 text-neutral-500">{loc.attempts}</td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  step="any"
                  placeholder="lat"
                  value={values[loc.id]?.lat ?? ""}
                  onChange={(e) =>
                    setValues((s) => ({ ...s, [loc.id]: { ...s[loc.id], lat: e.target.value, lng: s[loc.id]?.lng ?? "" } }))
                  }
                  className="w-24 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  step="any"
                  placeholder="lng"
                  value={values[loc.id]?.lng ?? ""}
                  onChange={(e) =>
                    setValues((s) => ({ ...s, [loc.id]: { ...s[loc.id], lng: e.target.value, lat: s[loc.id]?.lat ?? "" } }))
                  }
                  className="w-24 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100"
                />
              </td>
              <td className="px-3 py-2">
                <button
                  onClick={() => save(loc.id)}
                  disabled={savingId === loc.id || !values[loc.id]?.lat || !values[loc.id]?.lng}
                  className="rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-100 disabled:opacity-50"
                >
                  {savingId === loc.id ? "Saving…" : "Save"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
