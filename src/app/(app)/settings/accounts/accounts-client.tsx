"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Account = {
  id: string;
  email_address: string;
  display_name: string | null;
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

  async function editRampSchedule() {
    const current = account.ramp_schedule.map((r) => `${r.after_days}:${r.cap}`).join(", ");
    const raw = prompt(
      'Ramp schedule as "days after start:daily cap" pairs, e.g. "0:40, 3:75, 7:120, 14:150" — the cap in effect is whichever tier\'s day threshold has been reached:',
      current,
    );
    if (raw === null) return;

    const parsed = raw
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [days, cap] = pair.split(":").map((n) => parseInt(n.trim(), 10));
        return { after_days: days, cap };
      });

    if (
      parsed.length === 0 ||
      parsed.some((r) => !Number.isFinite(r.after_days) || !Number.isFinite(r.cap) || r.after_days < 0 || r.cap < 0)
    ) {
      alert('Couldn\'t parse that — use "days:cap" pairs separated by commas, e.g. "0:40, 3:75".');
      return;
    }
    parsed.sort((a, b) => a.after_days - b.after_days);

    setBusy("ramp");
    await fetch("/api/accounts/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: account.id, ramp_schedule: parsed }),
    });
    setBusy(null);
    router.refresh();
  }

  async function editDisplayName() {
    const name = prompt(
      "Display name shown in quoted replies (e.g. \"Jayme Stone\") — leave blank to just show the email address:",
      account.display_name ?? "",
    );
    if (name === null) return;
    setBusy("name");
    await fetch("/api/accounts/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: account.id, display_name: name }),
    });
    setBusy(null);
    router.refresh();
  }

  const statusTone = account.status === "active" ? "text-success" : account.status === "error" ? "text-error" : "text-faint";

  return (
    <div className="flex items-center justify-between rounded-[3px] border border-hairline bg-surface px-[22px] py-5">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="font-display text-[17px] text-ink">
            {account.display_name ? `${account.display_name} ` : ""}
            <span className={account.display_name ? "text-muted-3" : ""}>{account.email_address}</span>
          </span>
          <button onClick={editDisplayName} disabled={busy !== null} className="text-[11px] text-muted-3 hover:text-accent">
            {account.display_name ? "Edit name" : "+ Add display name"}
          </button>
          {isReplyTo && (
            <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] tracking-wide text-accent uppercase">
              Reply-to
            </span>
          )}
        </div>
        <div className="mt-1.5 text-xs text-muted-3" title={account.last_error ?? ""}>
          <span className={statusTone}>&#9679; {account.status}</span> · {account.ramp_schedule.map((r) => r.cap).join(" → ")}/day{" "}
          <button onClick={editRampSchedule} disabled={busy !== null} className="text-[11px] text-muted-3 hover:text-accent">
            Edit
          </button>
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
