"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Account = {
  id: string;
  email_address: string;
  can_send: boolean;
  status: string;
  last_error: string | null;
  ramp_schedule: { after_days: number; cap: number }[];
};

export function AccountRow({ account, isReplyTo }: { account: Account; isReplyTo: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function testSend() {
    setBusy("test");
    const res = await fetch("/api/oauth/google/test-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: account.id }),
    });
    const data = await res.json();
    setBusy(null);
    alert(res.ok ? `Test email sent to ${account.email_address}` : `Failed: ${data.error}`);
    router.refresh();
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${account.email_address}?`)) return;
    setBusy("disconnect");
    await fetch("/api/oauth/google/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: account.id }),
    });
    setBusy(null);
    router.refresh();
  }

  async function toggleCanSend() {
    setBusy("toggle");
    await fetch("/api/accounts/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: account.id, can_send: !account.can_send }),
    });
    setBusy(null);
    router.refresh();
  }

  async function makeReplyTo() {
    setBusy("reply-to");
    await fetch("/api/settings/reply-to", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: account.id }),
    });
    setBusy(null);
    router.refresh();
  }

  const statusTone = account.status === "active" ? "text-success" : account.status === "error" ? "text-error" : "text-faint";

  return (
    <div className="flex items-center justify-between rounded-[3px] border border-hairline bg-surface px-[22px] py-5">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="font-display text-[17px] text-ink">{account.email_address}</span>
          {isReplyTo && (
            <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] tracking-wide text-accent uppercase">
              Reply-to
            </span>
          )}
        </div>
        <div className="mt-1.5 text-xs text-muted-3" title={account.last_error ?? ""}>
          <span className={statusTone}>&#9679; {account.status}</span> · {account.ramp_schedule.map((r) => r.cap).join(" → ")}/day
          <label className="ml-3 inline-flex items-center gap-1.5 text-muted-3">
            <input type="checkbox" checked={account.can_send} onChange={toggleCanSend} disabled={busy === "toggle"} />
            Can send
          </label>
        </div>
      </div>
      <div className="flex shrink-0 gap-2.5">
        {!isReplyTo && (
          <button
            onClick={makeReplyTo}
            disabled={busy !== null}
            className="rounded-[2px] bg-neutral-badge-bg px-3.5 py-1.5 text-[11px] text-ink-soft disabled:opacity-50"
          >
            Set as Reply-To
          </button>
        )}
        <button
          onClick={testSend}
          disabled={busy !== null || account.status === "disconnected"}
          className="rounded-[2px] bg-neutral-badge-bg px-3.5 py-1.5 text-[11px] text-ink-soft disabled:opacity-50"
        >
          {busy === "test" ? "Sending…" : "Test send"}
        </button>
        <button
          onClick={disconnect}
          disabled={busy !== null || account.status === "disconnected"}
          className="rounded-[2px] border border-error/40 bg-transparent px-3.5 py-1.5 text-[11px] text-error disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}
