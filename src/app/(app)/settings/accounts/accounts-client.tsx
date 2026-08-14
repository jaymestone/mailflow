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

  const statusTone =
    account.status === "active" ? "text-emerald-400" : account.status === "error" ? "text-red-400" : "text-neutral-500";

  return (
    <tr className="border-b border-neutral-900">
      <td className="px-3 py-2 text-neutral-100">
        {account.email_address}
        {isReplyTo && (
          <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
            Reply-To
          </span>
        )}
      </td>
      <td className={`px-3 py-2 text-xs ${statusTone}`} title={account.last_error ?? ""}>
        {account.status}
      </td>
      <td className="px-3 py-2 text-xs text-neutral-400">
        {account.ramp_schedule.map((r) => r.cap).join(" → ")}/day
      </td>
      <td className="px-3 py-2">
        <label className="flex items-center gap-1.5 text-xs text-neutral-400">
          <input type="checkbox" checked={account.can_send} onChange={toggleCanSend} disabled={busy === "toggle"} />
          Can send
        </label>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-2">
          {!isReplyTo && (
            <button
              onClick={makeReplyTo}
              disabled={busy !== null}
              className="rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-100 disabled:opacity-50"
            >
              Set as Reply-To
            </button>
          )}
          <button
            onClick={testSend}
            disabled={busy !== null || account.status === "disconnected"}
            className="rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-100 disabled:opacity-50"
          >
            {busy === "test" ? "Sending…" : "Test send"}
          </button>
          <button
            onClick={disconnect}
            disabled={busy !== null || account.status === "disconnected"}
            className="rounded-md bg-neutral-800 px-2 py-1 text-xs text-red-400 disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      </td>
    </tr>
  );
}
