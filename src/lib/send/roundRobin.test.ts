import { describe, expect, it } from "vitest";
import { effectiveCap, pickNextAccount, type SendAccount } from "./roundRobin";

const RAMP = [
  { after_days: 0, cap: 40 },
  { after_days: 3, cap: 75 },
  { after_days: 7, cap: 120 },
  { after_days: 14, cap: 150 },
];

function account(id: string, rampStartedAt: string, ramp = RAMP): SendAccount {
  return { id, email_address: `${id}@example.com`, ramp_schedule: ramp, ramp_started_at: rampStartedAt };
}

describe("effectiveCap", () => {
  it("uses the first tier on day zero", () => {
    const a = account("a", "2026-08-24");
    expect(effectiveCap(a, new Date("2026-08-24T12:00:00Z"))).toBe(40);
  });

  it("steps up exactly on the tier boundary day, not before", () => {
    const a = account("a", "2026-08-01");
    expect(effectiveCap(a, new Date("2026-08-03T00:00:00Z"))).toBe(40);
    expect(effectiveCap(a, new Date("2026-08-04T00:00:00Z"))).toBe(75);
  });

  it("uses the highest tier reached when multiple thresholds have passed", () => {
    const a = account("a", "2026-08-01");
    expect(effectiveCap(a, new Date("2026-08-20T00:00:00Z"))).toBe(150);
  });

  it("falls back to 0 for an account with no ramp tiers", () => {
    const a = account("a", "2026-08-01", []);
    expect(effectiveCap(a, new Date("2026-08-24T00:00:00Z"))).toBe(0);
  });
});

describe("pickNextAccount", () => {
  const today = new Date("2026-08-24T12:00:00Z");

  it("returns null when there are no accounts", () => {
    expect(pickNextAccount([], -1, new Map(), today)).toBeNull();
  });

  it("starts just after the cursor and wraps around", () => {
    const accounts = [account("a", "2026-08-01"), account("b", "2026-08-01"), account("c", "2026-08-01")];
    const picked = pickNextAccount(accounts, 0, new Map(), today);
    expect(picked?.account.id).toBe("b");
    expect(picked?.nextCursor).toBe(1);
  });

  it("wraps from the last index back to the first", () => {
    const accounts = [account("a", "2026-08-01"), account("b", "2026-08-01")];
    const picked = pickNextAccount(accounts, 1, new Map(), today);
    expect(picked?.account.id).toBe("a");
    expect(picked?.nextCursor).toBe(0);
  });

  it("skips an account that is at its cap today", () => {
    const accounts = [account("a", "2026-08-24"), account("b", "2026-08-24")];
    const sentCounts = new Map([["a", 40]]); // "a" is at its day-0 cap of 40
    const picked = pickNextAccount(accounts, -1, sentCounts, today);
    expect(picked?.account.id).toBe("b");
  });

  it("returns null when every account is at capacity", () => {
    const accounts = [account("a", "2026-08-24"), account("b", "2026-08-24")];
    const sentCounts = new Map([
      ["a", 40],
      ["b", 40],
    ]);
    expect(pickNextAccount(accounts, -1, sentCounts, today)).toBeNull();
  });

  it("treats a missing sentCounts entry as zero sent", () => {
    const accounts = [account("a", "2026-08-24")];
    const picked = pickNextAccount(accounts, -1, new Map(), today);
    expect(picked?.account.id).toBe("a");
  });
});
