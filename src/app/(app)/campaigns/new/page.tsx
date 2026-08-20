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
      <h1 className="font-display text-[32px] font-medium text-ink">New campaign</h1>
      <form onSubmit={handleSubmit} className="mt-7 flex flex-col gap-5">
        <Field label="Name">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="2026 Fall Roster Pitch"
            className="border-0 border-b border-rule bg-transparent px-0.5 py-2 text-sm text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Artist(s)">
          <input
            value={artists}
            onChange={(e) => setArtists(e.target.value)}
            placeholder="Full roster"
            className="border-0 border-b border-rule bg-transparent px-0.5 py-2 text-sm text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="rounded-[2px] border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none"
          />
        </Field>
        {error && <p className="text-pretty text-sm text-error">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="self-start rounded-[2px] bg-ink px-[18px] py-2.5 text-xs font-semibold text-surface disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create campaign"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-[10px] tracking-wide text-faint uppercase">{label}</span>
      {children}
    </label>
  );
}
