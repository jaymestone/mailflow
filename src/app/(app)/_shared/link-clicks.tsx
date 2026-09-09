"use client";

import { useState } from "react";

type LinkClickEntry = {
  label: string;
  destination_url: string | null;
  step_number: number | null;
  campaign_name: string;
  clicked_at: string;
};

/** Expand-in-place per-contact click history: which links (e.g. which
 * artist's page) this contact has actually clicked, and when -- the
 * silent-engagement counterpart to ContactHistoryToggle's reply history,
 * for reading interest from a venue that browsed but never wrote back. */
export function LinkClicksToggle({ contactId }: { contactId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clicks, setClicks] = useState<LinkClickEntry[] | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (clicks) return;
    setLoading(true);
    const res = await fetch(`/api/contacts/${contactId}/link-clicks`);
    const data = await res.json();
    setLoading(false);
    if (res.ok) setClicks(data.clicks);
  }

  return (
    <div>
      <button type="button" onClick={toggle} className="text-[11px] text-muted-3 underline hover:text-accent">
        {open ? "Hide clicks" : "Link clicks"}
      </button>
      {open && (
        <div className="mt-1.5 min-w-[220px] rounded-[2px] border border-hairline bg-paper p-2.5 text-[11px]">
          {loading && <p className="text-faint-3">Loading…</p>}
          {!loading && clicks?.length === 0 && <p className="text-faint-3">No clicks yet.</p>}
          {!loading &&
            clicks?.map((c, i) => (
              <div key={i} className="border-b border-hairline-soft py-1.5 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-ink-soft">{c.label}</span>
                  {c.step_number != null && <span className="shrink-0 text-faint-2">step {c.step_number}</span>}
                </div>
                <div className="text-muted-2">
                  {c.campaign_name} · {new Date(c.clicked_at).toLocaleDateString()}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
