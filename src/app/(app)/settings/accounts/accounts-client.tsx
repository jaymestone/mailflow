"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type RampTier = { after_days: number; cap: number };

type Account = {
  id: string;
  email_address: string;
  display_name: string | null;
  can_send: boolean;
  status: string;
  last_error: string | null;
  ramp_schedule: RampTier[];
};

export function AccountRow({ account, isReplyTo }: { account: Account; isReplyTo: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editingRamp, setEditingRamp] = useState(false);
  const [rampDraft, setRampDraft] = useState<RampTier[]>(account.ramp_schedule);

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

  function openRampEditor() {
    setRampDraft(account.ramp_schedule.map((r) => ({ ...r })));
    setEditingRamp(true);
  }

  function updateTier(index: number, field: "after_days" | "cap", value: string) {
    const n = parseInt(value, 10);
    setRampDraft((tiers) => tiers.map((t, i) => (i === index ? { ...t, [field]: Number.isFinite(n) ? n : 0 } : t)));
  }

  function removeTier(index: number) {
    setRampDraft((tiers) => tiers.filter((_, i) => i !== index));
  }

  function addTier() {
    const last = rampDraft[rampDraft.length - 1];
    setRampDraft((tiers) => [...tiers, { after_days: (last?.after_days ?? 0) + 1, cap: last?.cap ?? 0 }]);
  }

  async function saveRampSchedule() {
    if (rampDraft.length === 0 || rampDraft.some((r) => r.after_days < 0 || r.cap < 0)) {
      alert("Every tier needs a non-negative day threshold and cap.");
      return;
    }
    const sorted = [...rampDraft].sort((a, b) => a.after_days - b.after_days);
    setBusy("ramp");
    await fetch("/api/accounts/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: account.id, ramp_schedule: sorted }),
    });
    setBusy(null);
    setEditingRamp(false);
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
    <div className="rounded-[3px] border border-hairline bg-surface px-[22px] py-5">
      <div className="flex items-center justify-between">
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
            {!editingRamp && (
              <button onClick={openRampEditor} disabled={busy !== null} className="text-[11px] text-muted-3 hover:text-accent">
                Edit
              </button>
            )}
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

      {editingRamp && (
        <div className="mt-4 rounded-[2px] border border-hairline bg-paper p-3.5">
          <p className="text-[11px] text-faint-2">
            Daily cap steps up as the account ages — the cap in effect is whichever tier&apos;s day threshold has
            been reached, starting from when the account was connected.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {rampDraft.map((tier, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-muted-2">
                <span className="text-faint-2">Day</span>
                <input
                  type="number"
                  min={0}
                  value={tier.after_days}
                  onChange={(e) => updateTier(i, "after_days", e.target.value)}
                  className="w-16 rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-ink outline-none"
                />
                <span className="text-faint-2">→ cap</span>
                <input
                  type="number"
                  min={0}
                  value={tier.cap}
                  onChange={(e) => updateTier(i, "cap", e.target.value)}
                  className="w-16 rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-ink outline-none"
                />
                <span className="text-faint-2">/day</span>
                <button onClick={() => removeTier(i)} className="ml-1 text-faint-3 hover:text-error">
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={addTier} className="text-[11px] text-muted-3 hover:text-accent">
              + Add tier
            </button>
          </div>
          <div className="mt-3.5 flex gap-2.5">
            <button
              onClick={saveRampSchedule}
              disabled={busy === "ramp"}
              className="rounded-[2px] bg-ink px-3 py-1.5 text-[11px] font-semibold text-surface disabled:opacity-50"
            >
              {busy === "ramp" ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditingRamp(false)} className="px-1 py-1.5 text-[11px] text-muted-3 hover:text-ink">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const DAYS = [
  { value: "mon", label: "Mon" },
  { value: "tue", label: "Tue" },
  { value: "wed", label: "Wed" },
  { value: "thu", label: "Thu" },
  { value: "fri", label: "Fri" },
  { value: "sat", label: "Sat" },
  { value: "sun", label: "Sun" },
];

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (America/New_York)" },
  { value: "America/Chicago", label: "Central (America/Chicago)" },
  { value: "America/Denver", label: "Mountain (America/Denver)" },
  { value: "America/Phoenix", label: "Arizona, no DST (America/Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific (America/Los_Angeles)" },
  { value: "America/Anchorage", label: "Alaska (America/Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Pacific/Honolulu)" },
];

function hourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${period}`;
}

export type SendWindow = {
  days: string[];
  start_hour: number;
  end_hour: number;
  timezone: string;
};

/** Controls when the send engine is allowed to fire at all (independent of
 * any one account's ramp) — applies to every campaign, since cold outreach
 * landing outside business hours reads as automated. */
export function SendWindowEditor({ sendWindow }: { sendWindow: SendWindow }) {
  const router = useRouter();
  const [draft, setDraft] = useState<SendWindow>(sendWindow);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  function toggleDay(day: string) {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day],
    }));
  }

  async function save() {
    if (draft.days.length === 0) {
      alert("Pick at least one day.");
      return;
    }
    if (draft.start_hour >= draft.end_hour) {
      alert("Start time must be before end time.");
      return;
    }
    setBusy(true);
    await fetch("/api/settings/send-window", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    setBusy(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="rounded-[3px] border border-hairline bg-surface px-[22px] py-5">
      <h2 className="font-display text-[17px] text-ink">Send window</h2>
      <p className="mt-1 text-xs text-muted-3">
        Campaign steps only send within this window, regardless of any one account&apos;s ramp schedule.
      </p>

      <div className="mt-3.5 flex flex-wrap gap-3.5">
        {DAYS.map((d) => (
          <label key={d.value} className="flex items-center gap-1.5 text-xs text-muted-2">
            <input type="checkbox" checked={draft.days.includes(d.value)} onChange={() => toggleDay(d.value)} />
            {d.label}
          </label>
        ))}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2.5 text-xs text-muted-2">
        <select
          value={draft.start_hour}
          onChange={(e) => {
            setSaved(false);
            setDraft((d) => ({ ...d, start_hour: parseInt(e.target.value, 10) }));
          }}
          className="rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-ink outline-none"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>
        <span className="text-faint-2">to</span>
        <select
          value={draft.end_hour}
          onChange={(e) => {
            setSaved(false);
            setDraft((d) => ({ ...d, end_hour: parseInt(e.target.value, 10) }));
          }}
          className="rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-ink outline-none"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>
        <select
          value={draft.timezone}
          onChange={(e) => {
            setSaved(false);
            setDraft((d) => ({ ...d, timezone: e.target.value }));
          }}
          className="rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-ink outline-none"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3.5 flex items-center gap-2.5">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-[2px] bg-ink px-3.5 py-1.5 text-[11px] font-semibold text-surface disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-[11px] text-success">Saved</span>}
      </div>
    </div>
  );
}
