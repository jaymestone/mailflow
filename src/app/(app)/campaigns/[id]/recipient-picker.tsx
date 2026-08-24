"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ContactFilterFields,
  EMPTY_CONTACT_FILTERS,
  type ContactFilters,
} from "../../_shared/contact-filter-fields";
import { ContactHistoryToggle } from "../../_shared/contact-history";

type ListOption = { id: string; name: string };
type SegmentOption = { id: string; name: string; count: number };
type CampaignOption = { id: string; name: string };

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

export function RecipientPicker({
  campaignId,
  lists,
  segments: initialSegments,
  campaigns,
}: {
  campaignId: string;
  lists: ListOption[];
  segments: SegmentOption[];
  campaigns: CampaignOption[];
}) {
  const router = useRouter();

  const [filters, setFilters] = useState<ContactFilters>(EMPTY_CONTACT_FILTERS);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [savingSegment, setSavingSegment] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [segments, setSegments] = useState(initialSegments);
  const [addResult, setAddResult] = useState<{ added: number; skippedSuppressed: number } | null>(null);

  const listNameById = useMemo(() => new Map(lists.map((l) => [l.id, l.name])), [lists]);

  function setField(key: keyof ContactFilters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    setAddResult(null);
    const payload = Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== ""));
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

  return (
    <div className="rounded-[3px] border border-hairline bg-surface p-5">
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
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.rows.slice(0, DISPLAY_CAP).map((r) => (
                      <tr key={r.id} className="border-b border-hairline-soft align-top hover:bg-paper">
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
                        <td className="px-3 py-2">
                          <ContactHistoryToggle contactId={r.id} />
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
              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={addSelected}
                  disabled={adding || selected.size === 0}
                  className="rounded-[2px] bg-ink px-4 py-2 text-xs font-semibold text-surface disabled:opacity-50"
                >
                  {adding ? "Adding…" : `Add ${selected.size} to campaign`}
                </button>
                <button
                  onClick={saveAsSegment}
                  disabled={savingSegment || selected.size === 0}
                  className="rounded-[2px] border border-hairline px-4 py-2 text-xs text-muted-3 hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  {savingSegment ? "Saving…" : `Save ${selected.size} as segment`}
                </button>
              </div>
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
