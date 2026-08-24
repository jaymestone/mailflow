"use client";

export type ContactFilters = {
  list: string;
  segment: string;
  state: string;
  city: string;
  country: string;
  venue_type: string;
  q: string;
  near: string;
  radius_min: string;
  radius_max: string;
  campaign: string;
  reply_status: string;
  never_contacted: string;
  not_active_elsewhere: string;
};

export const EMPTY_CONTACT_FILTERS: ContactFilters = {
  list: "",
  segment: "",
  state: "",
  city: "",
  country: "",
  venue_type: "",
  q: "",
  near: "",
  radius_min: "0",
  radius_max: "50",
  campaign: "",
  reply_status: "",
  never_contacted: "",
  not_active_elsewhere: "",
};

const REPLY_STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "no_reply", label: "No reply" },
  { value: "any_reply", label: "Any reply" },
  { value: "interested", label: "Interested" },
  { value: "not_interested", label: "Not interested" },
  { value: "follow_up", label: "Follow up" },
  { value: "ooo_temporary", label: "Out of office (temporary)" },
  { value: "ooo_departed", label: "Departed / venue closed" },
  { value: "opt_out", label: "Opted out" },
  { value: "bounce", label: "Bounced" },
  { value: "unclear", label: "Unclear" },
];

const inputClass =
  "w-16 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3";
const inputWideClass =
  "w-40 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint-3";
const selectClass = "w-32 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none";
const selectWideClass =
  "w-44 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none";
const milesClass =
  "w-14 border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-[13px] text-ink outline-none";

export function ContactFilterFields({
  filters,
  setField,
  lists,
  segments,
  campaigns,
  onSubmit,
  submitLabel,
  submitting,
}: {
  filters: ContactFilters;
  setField: (key: keyof ContactFilters, value: string) => void;
  lists: { id: string; name: string }[];
  segments: { id: string; name: string }[];
  campaigns: { id: string; name: string }[];
  onSubmit: (e: React.FormEvent) => void;
  submitLabel: string;
  submitting?: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-end gap-5">
        <Field label="List">
          <select value={filters.list} onChange={(e) => setField("list", e.target.value)} className={selectClass}>
            <option value="">All lists</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Segment">
          <select
            value={filters.segment}
            onChange={(e) => setField("segment", e.target.value)}
            className={selectClass}
          >
            <option value="">Any segment</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State">
          <input
            value={filters.state}
            onChange={(e) => setField("state", e.target.value)}
            placeholder="CA"
            className={inputClass}
          />
        </Field>
        <Field label="City">
          <input
            value={filters.city}
            onChange={(e) => setField("city", e.target.value)}
            placeholder="San Francisco"
            className={inputWideClass}
          />
        </Field>
        <Field label="Country">
          <input
            value={filters.country}
            onChange={(e) => setField("country", e.target.value)}
            placeholder="United States"
            className={inputWideClass}
          />
        </Field>
        <Field label="Venue type">
          <input
            value={filters.venue_type}
            onChange={(e) => setField("venue_type", e.target.value)}
            placeholder="Festival"
            className={inputClass}
          />
        </Field>
        <Field label="Search">
          <input
            value={filters.q}
            onChange={(e) => setField("q", e.target.value)}
            placeholder="venue, city, contact"
            className={inputWideClass}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-5 border-t border-hairline pt-4">
        <span className="pb-2 text-xs text-faint">By distance:</span>
        <Field label="Near">
          <input
            value={filters.near}
            onChange={(e) => setField("near", e.target.value)}
            placeholder="San Francisco, CA"
            className={inputWideClass}
          />
        </Field>
        <Field label="Min miles">
          <input
            type="number"
            min={0}
            value={filters.radius_min}
            onChange={(e) => setField("radius_min", e.target.value)}
            className={milesClass}
          />
        </Field>
        <Field label="Max miles">
          <input
            type="number"
            min={0}
            value={filters.radius_max}
            onChange={(e) => setField("radius_max", e.target.value)}
            className={milesClass}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-5 border-t border-hairline pt-4">
        <span className="pb-2 text-xs text-faint">By reply history:</span>
        <Field label="Campaign">
          <select
            value={filters.campaign}
            onChange={(e) => setField("campaign", e.target.value)}
            className={selectWideClass}
          >
            <option value="">Any campaign</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            value={filters.reply_status}
            onChange={(e) => setField("reply_status", e.target.value)}
            className={selectWideClass}
          >
            {REPLY_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-3">
          <input
            type="checkbox"
            checked={filters.never_contacted === "1"}
            onChange={(e) => setField("never_contacted", e.target.checked ? "1" : "")}
          />
          Never contacted
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-3">
          <input
            type="checkbox"
            checked={filters.not_active_elsewhere === "1"}
            onChange={(e) => setField("not_active_elsewhere", e.target.checked ? "1" : "")}
          />
          Not active elsewhere
        </label>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="self-start rounded-[2px] bg-ink px-[18px] py-2 text-xs font-semibold text-surface disabled:opacity-50"
      >
        {submitting ? "Searching…" : submitLabel}
      </button>
    </form>
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
