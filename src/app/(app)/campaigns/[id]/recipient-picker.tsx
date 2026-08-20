"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type ListOption = { id: string; name: string };

type SearchRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  venue: string | null;
  venue_type: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  list_id: string | null;
};

type SearchResponse = {
  rows: SearchRow[];
  fetchedCount: number;
  totalMatched: number | null;
  excludedSuppressed: number;
  excludedExisting: number;
  isRadiusMode: boolean;
  radiusNote: string | null;
  radiusCapped: boolean;
};

const DISPLAY_CAP = 300;

export function RecipientPicker({ campaignId, lists }: { campaignId: string; lists: ListOption[] }) {
  const router = useRouter();

  const [filters, setFilters] = useState({
    list: "",
    state: "",
    city: "",
    country: "",
    venue_type: "",
    q: "",
    near: "",
    radius_min: "",
    radius_max: "",
  });

  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addResult, setAddResult] = useState<{ added: number; skippedSuppressed: number } | null>(null);

  const listNameById = useMemo(() => new Map(lists.map((l) => [l.id, l.name])), [lists]);

  function setField(key: keyof typeof filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    setAddResult(null);
    const payload = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v.trim() !== ""),
    );
    const res = await fetch(`/api/campaigns/${campaignId}/members/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data: SearchResponse = await res.json();
    setSearching(false);
    if (res.ok) {
      setResults(data);
      setSelected(new Set(data.rows.map((r) => r.id))); // default: everything matched is selected
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!results) return;
    setSelected((s) => (s.size === results.rows.length ? new Set() : new Set(results.rows.map((r) => r.id))));
  }

  async function addSelected() {
    if (selected.size === 0) return;
    setAdding(true);
    const res = await fetch(`/api/campaigns/${campaignId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactIds: [...selected] }),
    });
    const data = await res.json();
    setAdding(false);
    if (res.ok) {
      setAddResult(data);
      setResults(null);
      setSelected(new Set());
      router.refresh();
    }
  }

  return (
    <div className="rounded-[3px] border border-hairline bg-surface p-5">
      <form onSubmit={search} className="flex flex-wrap items-end gap-5 text-sm">
        <Field label="List">
          <select
            value={filters.list}
            onChange={(e) => setField("list", e.target.value)}
            className="w-[130px] border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none"
          >
            <option value="">Any list</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State">
          <input
            value={filters.state}
            onChange={(e) => setField("state", e.target.value)}
            placeholder="CA"
            className="w-16 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="City">
          <input
            value={filters.city}
            onChange={(e) => setField("city", e.target.value)}
            placeholder="San Francisco"
            className="w-36 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Country">
          <input
            value={filters.country}
            onChange={(e) => setField("country", e.target.value)}
            placeholder="United States"
            className="w-36 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Venue type">
          <input
            value={filters.venue_type}
            onChange={(e) => setField("venue_type", e.target.value)}
            placeholder="Festival"
            className="w-28 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Search">
          <input
            value={filters.q}
            onChange={(e) => setField("q", e.target.value)}
            placeholder="venue, city, contact"
            className="w-44 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
      </form>

      <form onSubmit={search} className="mt-4 flex flex-wrap items-end gap-5 border-t border-hairline pt-4 text-sm">
        <span className="pb-2 text-xs text-faint">Or by distance:</span>
        <Field label="Near">
          <input
            value={filters.near}
            onChange={(e) => setField("near", e.target.value)}
            placeholder="San Francisco, CA"
            className="w-44 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Min miles">
          <input
            type="number"
            min={0}
            value={filters.radius_min}
            onChange={(e) => setField("radius_min", e.target.value)}
            placeholder="0"
            className="w-14 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Max miles">
          <input
            type="number"
            min={0}
            value={filters.radius_max}
            onChange={(e) => setField("radius_max", e.target.value)}
            placeholder="50"
            className="w-14 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <button
          type="submit"
          disabled={searching}
          className="rounded-[2px] bg-ink px-4 py-2 text-xs font-semibold text-surface disabled:opacity-50"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {addResult && (
        <p className="mt-4 text-xs text-muted-2">
          Added {addResult.added} to the campaign
          {addResult.skippedSuppressed > 0 && `, skipped ${addResult.skippedSuppressed} suppressed`}.
        </p>
      )}

      {results && (
        <div className="mt-5">
          {results.radiusNote && <p className="text-xs text-muted-3">{results.radiusNote}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-3">
            <span>
              {results.rows.length} eligible to add
              {results.excludedExisting > 0 && ` · ${results.excludedExisting} already in this campaign`}
              {results.excludedSuppressed > 0 && ` · ${results.excludedSuppressed} suppressed`}
              {results.radiusCapped && " · nearest 500 shown"}
            </span>
            {results.rows.length > 0 && (
              <button onClick={toggleAll} className="text-accent hover:underline">
                {selected.size === results.rows.length ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>

          {results.rows.length > 0 && (
            <>
              <div className="mt-2.5 max-h-80 overflow-y-auto rounded-[2px] border border-hairline">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 border-b border-hairline-strong bg-surface text-faint uppercase">
                    <tr>
                      <th className="w-8 px-3 py-2"></th>
                      <th className="px-3 py-2">Venue</th>
                      <th className="px-3 py-2">Contact</th>
                      <th className="px-3 py-2">City / State</th>
                      <th className="px-3 py-2">List</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.rows.slice(0, DISPLAY_CAP).map((r) => (
                      <tr key={r.id} className="border-b border-hairline-soft hover:bg-paper">
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                        </td>
                        <td className="px-3 py-2 font-display text-[13px] text-ink">{r.venue ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-2">
                          {[r.first_name, r.last_name].filter(Boolean).join(" ") || r.email}
                        </td>
                        <td className="px-3 py-2 text-muted-2">
                          {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-2">
                          {r.list_id ? (listNameById.get(r.list_id) ?? "—") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {results.rows.length > DISPLAY_CAP && (
                <p className="mt-1.5 text-xs text-faint-3">
                  Showing the first {DISPLAY_CAP} of {results.rows.length}. All {results.rows.length} stay selected
                  when added, even beyond what&apos;s shown here.
                </p>
              )}
              <button
                onClick={addSelected}
                disabled={adding || selected.size === 0}
                className="mt-4 rounded-[2px] bg-ink px-4 py-2 text-xs font-semibold text-surface disabled:opacity-50"
              >
                {adding ? "Adding…" : `Add ${selected.size} to campaign`}
              </button>
            </>
          )}
          {results.rows.length === 0 && (
            <p className="mt-2.5 text-xs text-muted-3">No eligible venues match these filters.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] tracking-wide text-faint uppercase">{label}</span>
      {children}
    </label>
  );
}
