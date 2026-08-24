"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Row = {
  key: string;
  first_name: string;
  last_name: string;
  email: string;
  venue: string;
  venue_type: string;
  city: string;
  state: string;
  country: string;
  mobile: string;
  phone: string;
  website: string;
  notes: string;
  source: string;
  enriching: boolean;
  enrichNote: string | null;
  enrichConfidence: "high" | "medium" | "low" | null;
};

type SaveResult = {
  inserted: number;
  skippedDuplicate: number;
  invalid: number;
  segment: { id: string; name: string } | null;
  addedToCampaign: number;
  skippedSuppressed: number;
};

type RowFieldKey =
  | "first_name"
  | "last_name"
  | "email"
  | "venue"
  | "venue_type"
  | "city"
  | "state"
  | "country"
  | "mobile"
  | "phone"
  | "website"
  | "source"
  | "notes";

const ENRICH_CONCURRENCY = 3;

function toRow(parsed: Record<string, string | null>): Row {
  const get = (k: string) => parsed[k] ?? "";
  return {
    key: crypto.randomUUID(),
    first_name: get("first_name"),
    last_name: get("last_name"),
    email: get("email"),
    venue: get("venue"),
    venue_type: get("venue_type"),
    city: get("city"),
    state: get("state"),
    country: get("country"),
    mobile: get("mobile"),
    phone: get("phone"),
    website: get("website"),
    notes: get("notes"),
    source: get("source"),
    enriching: false,
    enrichNote: null,
    enrichConfidence: null,
  };
}

export function QuickAddPanel({
  lists,
  campaigns,
}: {
  lists: { id: string; name: string }[];
  campaigns: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [enrichingAll, setEnrichingAll] = useState(false);

  const [listId, setListId] = useState("");
  const [newListName, setNewListName] = useState("");
  const [segmentName, setSegmentName] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  async function handleParse() {
    if (!rawText.trim()) return;
    setParsing(true);
    setParseError(null);
    setSaveResult(null);
    const res = await fetch("/api/import/quick-add/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText }),
    });
    const data = await res.json();
    setParsing(false);
    if (!res.ok) {
      setParseError(data.error ?? "Could not parse contacts");
      return;
    }
    setRows((data.contacts as Record<string, string | null>[]).map(toRow));
  }

  function updateRow(key: string, field: RowFieldKey, value: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  async function enrichRow(key: string) {
    const row = rows.find((r) => r.key === key);
    if (!row || !row.venue.trim()) return;

    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, enriching: true } : r)));
    const res = await fetch("/api/import/quick-add/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        first_name: row.first_name || null,
        last_name: row.last_name || null,
        email: row.email || null,
        venue: row.venue,
        city: row.city || null,
        state: row.state || null,
        country: row.country || null,
      }),
    });
    const data = await res.json();

    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        if (!res.ok) {
          return { ...r, enriching: false, enrichNote: data.error ?? "Enrichment failed" };
        }
        const result = data.result;
        return {
          ...r,
          enriching: false,
          enrichNote: result.note || null,
          enrichConfidence: result.confidence,
          // Fill blanks only — never overwrite what was already parsed/typed.
          first_name: r.first_name || result.first_name || "",
          last_name: r.last_name || result.last_name || "",
          city: r.city || result.city || "",
          state: r.state || result.state || "",
          country: r.country || result.country || "",
          venue_type: r.venue_type || result.venue_type || "",
          phone: r.phone || result.phone || "",
          website: r.website || result.website || "",
        };
      }),
    );
  }

  async function enrichAll() {
    setEnrichingAll(true);
    const keys = rows.filter((r) => r.venue.trim()).map((r) => r.key);
    let cursor = 0;
    async function worker() {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        await enrichRow(key);
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
    setEnrichingAll(false);
  }

  async function handleSave() {
    if (rows.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const payload = {
      contacts: rows.map((r) => ({
        first_name: r.first_name || null,
        last_name: r.last_name || null,
        email: r.email,
        venue: r.venue || null,
        venue_type: r.venue_type || null,
        city: r.city || null,
        state: r.state || null,
        country: r.country || null,
        mobile: r.mobile || null,
        phone: r.phone || null,
        website: r.website || null,
        notes: r.notes || null,
        source: r.source || null,
      })),
      listId: listId || undefined,
      newListName: newListName || undefined,
      segmentName: segmentName || undefined,
      campaignId: campaignId || undefined,
    };
    const res = await fetch("/api/import/quick-add/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setSaveError(data.error ?? "Save failed");
      return;
    }
    setSaveResult(data);
    setRows([]);
    setRawText("");
    router.refresh();
  }

  return (
    <div>
      <label className="block text-[10px] tracking-wide text-faint uppercase">Paste contacts</label>
      <textarea
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
        rows={6}
        placeholder={`Jane Doe, jane@theblueroom.com, The Blue Room, Austin\nTom Schaub — booking@michiganirish.org — Michigan Irish Music Festival, Muskegon MI\n...`}
        className="mt-1.5 w-full rounded-[2px] border border-hairline bg-paper px-3 py-2.5 font-mono text-xs text-ink outline-none placeholder:text-faint-3"
      />
      <p className="mt-1.5 text-xs text-faint-2">
        One or many contacts, any format — name, email, venue, city are enough. Missing fields (state, website,
        venue type, ...) can be filled in automatically after parsing.
      </p>

      <button
        onClick={handleParse}
        disabled={parsing || !rawText.trim()}
        className="mt-3 rounded-[2px] bg-ink px-4 py-2.5 text-xs font-semibold text-surface disabled:opacity-50"
      >
        {parsing ? "Parsing…" : "Parse"}
      </button>
      {parseError && <p className="mt-2.5 text-xs text-error">{parseError}</p>}

      {rows.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-3">{rows.length} parsed</span>
            <button
              onClick={enrichAll}
              disabled={enrichingAll}
              className="rounded-[2px] border border-hairline px-3.5 py-2 text-xs text-muted-3 hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {enrichingAll ? "Enriching…" : "Enrich all"}
            </button>
          </div>

          <div className="mt-2.5 flex flex-col gap-3">
            {rows.map((r) => (
              <div key={r.key} className="rounded-[2px] border border-hairline bg-surface p-3.5">
                <div className="grid grid-cols-3 gap-2.5 gap-y-2">
                  <RowField label="First name" value={r.first_name} onChange={(v) => updateRow(r.key, "first_name", v)} />
                  <RowField label="Last name" value={r.last_name} onChange={(v) => updateRow(r.key, "last_name", v)} />
                  <RowField label="Email" value={r.email} onChange={(v) => updateRow(r.key, "email", v)} />
                  <RowField label="Venue" value={r.venue} onChange={(v) => updateRow(r.key, "venue", v)} />
                  <RowField label="Venue type" value={r.venue_type} onChange={(v) => updateRow(r.key, "venue_type", v)} />
                  <RowField label="City" value={r.city} onChange={(v) => updateRow(r.key, "city", v)} />
                  <RowField label="State" value={r.state} onChange={(v) => updateRow(r.key, "state", v)} />
                  <RowField label="Country" value={r.country} onChange={(v) => updateRow(r.key, "country", v)} />
                  <RowField label="Mobile" value={r.mobile} onChange={(v) => updateRow(r.key, "mobile", v)} />
                  <RowField label="Phone" value={r.phone} onChange={(v) => updateRow(r.key, "phone", v)} />
                  <RowField label="Website" value={r.website} onChange={(v) => updateRow(r.key, "website", v)} />
                  <RowField label="Source" value={r.source} onChange={(v) => updateRow(r.key, "source", v)} />
                  <RowField label="Notes" value={r.notes} onChange={(v) => updateRow(r.key, "notes", v)} wide />
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-3">
                  <div className="text-[11px] text-faint-2">
                    {r.enriching
                      ? "Researching…"
                      : r.enrichNote
                        ? `${r.enrichConfidence ? `[${r.enrichConfidence} confidence] ` : ""}${r.enrichNote}`
                        : null}
                  </div>
                  <div className="flex shrink-0 gap-3">
                    <button
                      onClick={() => enrichRow(r.key)}
                      disabled={r.enriching || !r.venue.trim()}
                      className="text-xs text-muted-3 hover:text-accent disabled:opacity-50"
                    >
                      Enrich
                    </button>
                    <button onClick={() => removeRow(r.key)} className="text-xs text-error hover:underline">
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-[2px] border border-hairline bg-surface p-4">
            <div className="text-xs font-semibold text-ink">Add to (optional)</div>
            <div className="mt-3 flex flex-wrap items-end gap-5 text-sm">
              <Field label="Existing list">
                <select
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
                  className="w-40 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none"
                >
                  <option value="">None</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Or new list">
                <input
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  disabled={!!listId}
                  placeholder="List name"
                  className="w-40 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3 disabled:opacity-40"
                />
              </Field>
              <Field label="Save as segment">
                <input
                  value={segmentName}
                  onChange={(e) => setSegmentName(e.target.value)}
                  placeholder="Segment name"
                  className="w-40 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3"
                />
              </Field>
              <Field label="Enroll in campaign">
                <select
                  value={campaignId}
                  onChange={(e) => setCampaignId(e.target.value)}
                  className="w-44 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none"
                >
                  <option value="">None</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="mt-4 rounded-[2px] bg-ink px-4 py-2.5 text-xs font-semibold text-surface disabled:opacity-50"
          >
            {saving ? "Saving…" : `Save ${rows.length} contact${rows.length === 1 ? "" : "s"}`}
          </button>
          {saveError && <p className="mt-2.5 text-xs text-error">{saveError}</p>}
        </div>
      )}

      {saveResult && (
        <div className="mt-6 rounded-[2px] border border-hairline bg-surface p-4 text-xs text-muted-2">
          <div className="grid grid-cols-3 gap-4 text-center">
            <Stat label="Inserted" value={saveResult.inserted} tone="text-success" />
            <Stat label="Skipped (dupes)" value={saveResult.skippedDuplicate} />
            <Stat label="Invalid email" value={saveResult.invalid} tone="text-error" />
          </div>
          {saveResult.segment && (
            <p className="mt-3 text-center">
              Added to segment &ldquo;{saveResult.segment.name}&rdquo;.
            </p>
          )}
          {saveResult.addedToCampaign > 0 && (
            <p className="mt-1 text-center">
              Enrolled {saveResult.addedToCampaign} in the campaign
              {saveResult.skippedSuppressed > 0 && `, skipped ${saveResult.skippedSuppressed} suppressed`}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RowField({
  label,
  value,
  onChange,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "col-span-3" : ""}`}>
      <span className="text-[9px] tracking-wide text-faint uppercase">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none"
      />
    </label>
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className={`font-display text-xl ${tone ?? "text-ink"}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-3">{label}</div>
    </div>
  );
}
