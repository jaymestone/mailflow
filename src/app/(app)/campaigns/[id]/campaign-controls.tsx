"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StatusControl({ campaignId, status }: { campaignId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setStatus(next: string) {
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
