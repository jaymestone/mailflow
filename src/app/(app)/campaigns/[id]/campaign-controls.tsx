"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ListOption = { id: string; name: string };

export function StatusControl({ campaignId, status }: { campaignId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setStatus(next: string) {
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-neutral-500">Status: {status}</span>
      {status !== "active" && (
        <button
          onClick={() => setStatus("active")}
          disabled={busy}
          className="rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-400 disabled:opacity-50"
        >
          Activate
        </button>
      )}
      {status === "active" && (
        <button
          onClick={() => setStatus("paused")}
          disabled={busy}
          className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-400 disabled:opacity-50"
        >
          Pause
        </button>
      )}
      {status !== "completed" && (
        <button
          onClick={() => setStatus("completed")}
          disabled={busy}
          className="rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-400 disabled:opacity-50"
        >
          Mark completed
        </button>
      )}
    </div>
  );
}

export function AddRecipientsForm({ campaignId, lists }: { campaignId: string; lists: ListOption[] }) {
  const router = useRouter();
  const [listId, setListId] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; skippedSuppressed: number } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await fetch(`/api/campaigns/${campaignId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list_id: listId || undefined, state: state || undefined, city: city || undefined, country: country || undefined }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) {
      setResult(data);
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">List</span>
        <select
          value={listId}
          onChange={(e) => setListId(e.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100"
        >
          <option value="">Any list</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">State</span>
        <input value={state} onChange={(e) => setState(e.target.value)} className="w-24 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">City</span>
        <input value={city} onChange={(e) => setCity(e.target.value)} className="w-36 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">Country</span>
        <input value={country} onChange={(e) => setCountry(e.target.value)} className="w-36 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100" />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-neutral-50 px-3 py-1.5 text-xs font-medium text-neutral-950 disabled:opacity-50"
      >
        {busy ? "Adding…" : "Add matching venues"}
      </button>
      {result && (
        <span className="text-xs text-neutral-400">
          Added {result.added}
          {result.skippedSuppressed > 0 && `, skipped ${result.skippedSuppressed} suppressed`}
        </span>
      )}
    </form>
  );
}

export function RemoveMemberButton({ campaignId, contactId }: { campaignId: string; contactId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <button onClick={remove} disabled={busy} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">
      Remove
    </button>
  );
}
