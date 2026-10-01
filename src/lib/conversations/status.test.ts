import { describe, expect, it } from "vitest";
import { computeIsLive, computeStatus } from "./status";

const base = { isAgreed: false, isSmall: false, feeAmount: null, lastDirection: null } as const;

describe("computeStatus", () => {
  it("reports who is up when there is no money on the table", () => {
    expect(computeStatus({ ...base, lastDirection: "inbound" })).toBe("needs_reply");
    expect(computeStatus({ ...base, lastDirection: "outbound" })).toBe("awaiting_them");
  });

  it("treats an unknown direction as needing a reply", () => {
    // Safer to surface a thread Jayme has already handled than to hide one
    // he hasn't.
    expect(computeStatus({ ...base, lastDirection: null })).toBe("needs_reply");
  });

  it("puts a named figure ahead of who wrote last", () => {
    expect(computeStatus({ ...base, feeAmount: 3500, lastDirection: "inbound" })).toBe("numbers_on_table");
    expect(computeStatus({ ...base, feeAmount: 3500, lastDirection: "outbound" })).toBe("numbers_on_table");
  });

  it("parks a small deal", () => {
    expect(computeStatus({ ...base, isSmall: true, lastDirection: "inbound" })).toBe("parked");
    // A figure at or under the ceiling parks itself even when the
    // summariser did not flag it as small.
    expect(computeStatus({ ...base, feeAmount: 400 })).toBe("parked");
    expect(computeStatus({ ...base, feeAmount: 1000 })).toBe("parked");
    expect(computeStatus({ ...base, feeAmount: 1001 })).toBe("numbers_on_table");
  });

  it("confirms an agreed booking even when it is small", () => {
    // An agreed deal still needs a contract. Size decides what is worth
    // chasing, not what is worth honouring.
    expect(computeStatus({ ...base, isAgreed: true, isSmall: true, feeAmount: 300 })).toBe("confirmed");
  });

  it("confirms regardless of who wrote last", () => {
    expect(computeStatus({ ...base, isAgreed: true, lastDirection: "outbound" })).toBe("confirmed");
  });
});

describe("computeIsLive", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  it("keeps a recently active thread", () => {
    expect(computeIsLive({ lastMessageAt: "2026-09-28T00:00:00Z", feeAmount: null, isAgreed: false, now })).toBe(true);
  });

  it("drops a silent thread with no money attached", () => {
    expect(computeIsLive({ lastMessageAt: "2026-08-01T00:00:00Z", feeAmount: null, isAgreed: false, now })).toBe(false);
  });

  it("keeps a silent thread that has a number on it", () => {
    // Worth money; a quiet month does not change that.
    expect(computeIsLive({ lastMessageAt: "2026-01-01T00:00:00Z", feeAmount: 4000, isAgreed: false, now })).toBe(true);
  });

  it("keeps an agreed booking however old", () => {
    expect(computeIsLive({ lastMessageAt: "2025-06-01T00:00:00Z", feeAmount: null, isAgreed: true, now })).toBe(true);
  });

  it("is inclusive at exactly the threshold", () => {
    expect(computeIsLive({ lastMessageAt: "2026-09-01T00:00:00Z", feeAmount: null, isAgreed: false, now })).toBe(true);
  });

  it("drops a thread with no messages at all", () => {
    expect(computeIsLive({ lastMessageAt: null, feeAmount: null, isAgreed: false, now })).toBe(false);
  });
});
