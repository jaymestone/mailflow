"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StatusControl({
  campaignId,
  status,
  memberCount,
  hasTestOverride,
}: {
  campaignId: string;
  status: string;
  memberCount: number;
  hasTestOverride: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setStatus(next: string) {
    if (next === "active") {
      const warning = hasTestOverride
        ? `⚠ One or more steps still have a testing cadence override active — real recipients would get follow-ups on that fast schedule instead of the intended one. Activate anyway?`
        : `Activate this campaign? It will start sending real email to ${memberCount} recipient${memberCount === 1 ? "" : "s"} on its normal schedule.`;
      if (!confirm(warning)) return;
    }
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    router.refresh();
  }

  const statusColor = status === "active" ? "text-success" : status === "paused" ? "text-warning" : "text-faint";

  return (
    <div className="flex items-center gap-3">
      <span className={`text-xs capitalize ${statusColor}`}>&#9679; {status}</span>
      {status !== "active" && (
        <button
          onClick={() => setStatus("active")}
          disabled={busy}
          className="rounded-[2px] bg-success-bg px-2.5 py-1 text-xs text-success disabled:opacity-50"
        >
          Activate
        </button>
      )}
      {status === "active" && (
        <button
          onClick={() => setStatus("paused")}
          disabled={busy}
          className="rounded-[2px] bg-warning-bg px-2.5 py-1 text-xs text-warning disabled:opacity-50"
        >
          Pause
        </button>
      )}
      {status !== "completed" && (
        <button
          onClick={() => setStatus("completed")}
          disabled={busy}
          className="rounded-[2px] bg-neutral-badge-bg px-2.5 py-1 text-xs text-muted-3 disabled:opacity-50"
        >
          Mark completed
        </button>
      )}
    </div>
  );
}

export function RemoveMemberButton({ campaignId, contactId }: { campaignId: string; contactId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirm("Remove this recipient from the campaign?")) return;
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
    <button onClick={remove} disabled={busy} className="text-xs text-error hover:underline disabled:opacity-50">
      Remove
    </button>
  );
}
