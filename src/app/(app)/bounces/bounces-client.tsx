"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const REASONS = [
  { value: "bounce", label: "Bounced" },
  { value: "opt_out", label: "Opted out" },
  { value: "manual", label: "Manual / other" },
];

/** Paste anything email-shaped — a bare list, or raw CSV/export content —
 * and every address found gets added to the permanent suppression list,
 * skipping ones already there. */
export function AddSuppressionForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [reason, setReason] = useState("bounce");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ found: number; added: number; alreadySuppressed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await fetch("/api/suppression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, reason }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error);
      return;
    }
    setResult(data);
    setText("");
    router.refresh();
  }

  return (
    <section className="mt-10 rounded-[3px] border border-hairline bg-surface p-5">
      <h2 className="font-display text-[19px] text-ink">Add to suppression list</h2>
      <p className="mt-1 text-xs text-muted-3">
        Paste emails — one per line, comma-separated, or raw CSV content. Anything email-shaped is picked out
        automatically.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="jane@venue.com&#10;john@festival.org&#10;..."
        className="mt-3 w-full rounded-[2px] border border-hairline bg-paper px-2.5 py-2 text-xs text-ink outline-none placeholder:text-faint-3"
      />
      <div className="mt-3 flex items-center gap-3">
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-xs text-ink outline-none"
        >
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          className="rounded-[2px] bg-ink px-3.5 py-1.5 text-xs font-semibold text-surface disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add to suppression"}
        </button>
      </div>
      {error && <p className="mt-2.5 text-xs text-error">{error}</p>}
      {result && (
        <p className="mt-2.5 text-xs text-muted-2">
          Found {result.found} address{result.found === 1 ? "" : "es"} — added {result.added}, {result.alreadySuppressed}{" "}
          already suppressed.
        </p>
      )}
    </section>
  );
}

/** Triggers the same batch the weekly cron runs, on demand — processes up
 * to 8 pending queue items per call (see replacementTick.ts), so a large
 * backlog may need a couple of clicks (or just the next scheduled run) to
 * fully clear. */
export function RunReplacementResearchButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/research/replacement-tick", { method: "POST" });
    const data = await res.json();
    setBusy(false);
    setResult(
      res.ok
        ? data.processed === 0
          ? "Nothing pending."
          : `Researched ${data.processed} — ${data.replaced} replaced, ${data.noReplacementFound} not found, ${data.skipped} skipped.`
        : "Failed to run research",
    );
    router.refresh();
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-[2px] bg-ink px-4 py-2.5 text-xs font-semibold text-surface disabled:opacity-50"
      >
        {busy ? "Researching…" : "Run research now"}
      </button>
      {result && <p className="text-right text-xs text-muted-3">{result}</p>}
    </div>
  );
}

export function RestoreButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function restore() {
    if (!confirm("Restore this address? It will become eligible for sending again.")) return;
    setBusy(true);
    await fetch("/api/suppression/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <button onClick={restore} disabled={busy} className="text-xs text-accent hover:underline disabled:opacity-50">
      Restore
    </button>
  );
}
