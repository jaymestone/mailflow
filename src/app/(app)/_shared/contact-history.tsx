"use client";

import { useState } from "react";

type CampaignHistoryEntry = {
  campaign_id: string;
  campaign_name: string;
  member_status: string;
  current_step: number;
  last_sent_at: string | null;
  replies: {
    message_type: string;
    classification_category: string | null;
    subject: string | null;
    received_at: string;
  }[];
};

/** Expand-in-place per-contact history: every campaign they've been part of
 * and how they replied to each one — for judgment calls a filter can't make
 * on its own (e.g. "not interested" on a roster pitch vs "interested" on a
 * specific artist's follow-up). */
export function ContactHistoryToggle({ contactId }: { contactId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [campaigns, setCampaigns] = useState<CampaignHistoryEntry[] | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (campaigns) return;
    setLoading(true);
    const res = await fetch(`/api/contacts/${contactId}/history`);
    const data = await res.json();
    setLoading(false);
    if (res.ok) setCampaigns(data.campaigns);
  }

  return (
    <div>
      <button type="button" onClick={toggle} className="text-[11px] text-muted-3 underline hover:text-accent">
        {open ? "Hide history" : "History"}
      </button>
      {open && (
        <div className="mt-1.5 min-w-[220px] rounded-[2px] border border-hairline bg-paper p-2.5 text-[11px]">
          {loading && <p className="text-faint-3">Loading…</p>}
          {!loading && campaigns?.length === 0 && <p className="text-faint-3">Never part of a campaign.</p>}
          {!loading &&
            campaigns?.map((c) => (
              <div key={c.campaign_id} className="border-b border-hairline-soft py-1.5 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-ink-soft">{c.campaign_name}</span>
                  <span className="shrink-0 text-faint-2">
                    {c.member_status} · step {c.current_step}
                  </span>
                </div>
                {c.replies.length === 0 ? (
                  <span className="text-faint-3">No reply</span>
                ) : (
                  c.replies.map((r, i) => (
                    <div key={i} className="text-muted-2">
                      {(r.classification_category ?? r.message_type).replace(/_/g, " ")}
                      {r.received_at && ` · ${new Date(r.received_at).toLocaleDateString()}`}
                    </div>
                  ))
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
