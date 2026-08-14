"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewCampaignPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [artists, setArtists] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, artists, notes }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to create campaign");
      setSaving(false);
      return;
    }
    router.push(`/campaigns/${data.id}`);
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-balance text-2xl font-semibold">New campaign</h1>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <Field label="Name">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="2026 Fall Roster Pitch"
            className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
          />
        </Field>
        <Field label="Artist(s)">
          <input
            value={artists}
            onChange={(e) => setArtists(e.target.value)}
            placeholder="Full roster"
            className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
          />
        </Field>
        {error && <p className="text-pretty text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="self-start rounded-lg bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create campaign"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-400">{label}</span>
      {children}
    </label>
  );
}
