"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ContactFilterFields,
  EMPTY_CONTACT_FILTERS,
  type ContactFilters,
} from "../_shared/contact-filter-fields";
import { ContactHistoryToggle } from "../_shared/contact-history";

type ContactRow = {
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
  geocode_status: string;
  suppressed: boolean;
};

type SearchResponse = {
  rows: ContactRow[];
  count: number | null;
  isRadiusMode: boolean;
  radiusNote: string | null;
  radiusCapped: boolean;
};

type SegmentOption = { id: string; name: string; count: number };

export function VenuesClient({
  lists,
  segments: initialSegments,
  campaigns,
}: {
  lists: { id: string; name: string }[];
  segments: SegmentOption[];
  campaigns: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<ContactFilters>(EMPTY_CONTACT_FILTERS);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [segments, setSegments] = useState(initialSegments);
  const [savingSegment, setSavingSegment] = useState(false);
  const [targetCampaign, setTargetCampaign] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{ added: number; skippedSuppressed: number } | null>(null);

  async function runSearch(f: ContactFilters) {
    setSearching(true);
    setAddResult(null);
    const payload = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== ""));
    const res = await fetch("/api/venues/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data: SearchResponse = await res.json();
    setSearching(false);
    if (res.ok) {
      setResults(data);
      setSelected(new Set(data.rows.filter((r) => !r.suppressed).map((r) => r.id)));
    }
  }

  // Load the full contact book on first visit, matching the page's previous
  // default-browse behavior, before any filter has been applied. Deferred to
  // a microtask so the resulting setState calls land outside the effect's
  // own synchronous commit.
  useEffect(() => {
    queueMicrotask(() => runSearch(EMPTY_CONTACT_FILTERS));
  }, []);

  function setField(key: keyof ContactFilters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    runSearch(filters);
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
    const selectable = results.rows.filter((r) => !r.suppressed).map((r) => r.id);
    setSelected((s) => (s.size === selectable.length ? new Set() : new Set(selectable)));
  }

  async function saveAsSegment() {
    if (selected.size === 0) return;
    const name = prompt("Save this selection as a segment named:");
    if (!name?.trim()) return;

    setSavingSegment(true);
    const res = await fetch("/api/venues/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, contactIds: [...selected] }),
    });
    const data = await res.json();
    setSavingSegment(false);
    if (res.ok) {
      setSegments((s) => {
        const withoutOld = s.filter((seg: SegmentOption) => seg.id !== data.segment.id);
        return [...withoutOld, data.segment as SegmentOption].sort((a, b) => a.name.localeCompare(b.name));
      });
    }
  }

  async function addToCampaign() {
    if (selected.size === 0 || !targetCampaign) return;
    setAdding(true);
    const res = await fetch(`/api/campaigns/${targetCampaign}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactIds: [...selected] }),
    });
    const data = await res.json();
    setAdding(false);
    if (res.ok) {
      setAddResult(data);
      router.refresh();
    }
  }

  const selectableCount = results ? results.rows.filter((r) => !r.suppressed).length : 0;

  return (
    <div>
      <div className="border-b border-hairline pb-5">
        <ContactFilterFields
          filters={filters}
          setField={setField}
          lists={lists}
          segments={segments}
          campaigns={campaigns}
          onSubmit={search}
          submitLabel="Search"
          submitting={searching}
        />
      </div>

      {results && (
        <div className="mt-5">
          {results.radiusNote && (
            <p className="text-xs text-muted-3">
              {results.radiusNote}
              {results.radiusCapped && " — showing the nearest 500."}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-3">
            <span>
              {results.count ?? results.rows.length} matched
              {results.rows.length !== (results.count ?? results.rows.length) &&
                ` · showing ${results.rows.length}`}
            </span>
            {selectableCount > 0 && (
              <button onClick={toggleAll} className="text-accent hover:underline">
                {selected.size === selectableCount ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>

          {results.rows.length > 0 ? (
            <div className="mt-2.5 overflow-x-auto rounded-[2px] border border-hairline">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="border-b border-hairline-strong bg-surface text-faint uppercase">
                  <tr>
                    <th className="w-8 px-3 py-2"></th>
                    <th className="px-3 py-2">Venue</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Contact</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((r) => (
                    <tr key={r.id} className="border-b border-hairline-soft align-top hover:bg-paper">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          disabled={r.suppressed}
                          onChange={() => toggle(r.id)}
                        />
                      </td>
                      <td className="px-3 py-2 font-display text-[13px] text-ink">
                        {r.venue ?? "—"}
                        {r.suppressed && <span className="ml-1.5 text-[10px] text-error">suppressed</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-2">{r.venue_type ?? "—"}</td>
                      <td className="px-3 py-2 text-ink-soft">
                        {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-muted-2">{r.email}</td>
                      <td className="px-3 py-2 text-muted-2">
                        {[r.city, r.state].filter(Boolean).join(", ") || r.country || "—"}
                      </td>
                      <td className="px-3 py-2">
                        <ContactHistoryToggle contactId={r.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-3">No venues match these filters.</div>
          )}

          {results.rows.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={saveAsSegment}
                disabled={savingSegment || selected.size === 0}
                className="rounded-[2px] border border-hairline px-3.5 py-2 text-xs text-muted-3 hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {savingSegment ? "Saving…" : `Save ${selected.size} as segment`}
              </button>

              <select
                value={targetCampaign}
                onChange={(e) => setTargetCampaign(e.target.value)}
                className="border-0 border-b border-rule bg-transparent px-0.5 py-2 text-xs text-ink outline-none"
              >
                <option value="">Choose a campaign…</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                onClick={addToCampaign}
                disabled={adding || selected.size === 0 || !targetCampaign}
                className="rounded-[2px] bg-ink px-3.5 py-2 text-xs font-semibold text-surface disabled:opacity-50"
              >
                {adding ? "Adding…" : `Add ${selected.size} to campaign`}
              </button>
            </div>
          )}

          {addResult && (
            <p className="mt-2.5 text-xs text-muted-2">
              Added {addResult.added} to the campaign
              {addResult.skippedSuppressed > 0 && `, skipped ${addResult.skippedSuppressed} suppressed`}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
