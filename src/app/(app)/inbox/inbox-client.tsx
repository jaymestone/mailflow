"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const CATEGORIES = ["interested", "not_interested", "follow_up", "ooo", "opt_out", "bounce", "unclear"];

export function PollNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function poll() {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/reply/tick", { method: "POST" });
    const data = await res.json();
    setBusy(false);
    setResult(
      res.ok
        ? `Polled ${data.accountsPolled} accounts, ${data.messagesFetched} new messages (${data.replies} replies, ${data.bounces} bounces)`
        : "Failed to poll",
    );
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={poll}
        disabled={busy}
        className="rounded-[2px] bg-ink px-4 py-2.5 text-xs font-semibold text-surface disabled:opacity-50"
      >
        {busy ? "Polling…" : "Poll now"}
      </button>
      {result && <span className="text-xs text-muted-3">{result}</span>}
    </div>
  );
}

export function CategorySelect({ id, category }: { id: string; category: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function change(next: string) {
    setBusy(true);
    await fetch("/api/inbox/reclassify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, category: next }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <select
      value={category ?? "unclear"}
      onChange={(e) => change(e.target.value)}
      disabled={busy}
      className="rounded-full border border-hairline-strong bg-surface px-2.5 py-1 text-[11px] text-ink-soft"
    >
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c.replace("_", " ")}
        </option>
      ))}
    </select>
  );
}
