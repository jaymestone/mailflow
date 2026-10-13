import { describe, expect, it } from "vitest";
import { decide, type GateState } from "./changeGate";

const now = new Date("2026-10-13T12:00:00Z");
const state = (over: Partial<GateState> = {}): GateState => ({
  signature: "sig", fullRunAt: "2026-10-13T11:30:00Z", pendingSummaries: 0, nextRetryAt: null, ...over,
});

describe("conversations change gate", () => {
  it("runs everything the first time", () => {
    expect(decide(null, "sig", now)).toMatchObject({ build: true, summarize: true });
  });
  it("skips both passes when nothing changed and nothing is pending", () => {
    expect(decide(state(), "sig", now)).toMatchObject({ build: false, summarize: false, reason: "unchanged" });
  });
  it("rebuilds when the signature moves", () => {
    expect(decide(state(), "sig2", now)).toMatchObject({ build: true, summarize: true, reason: "changed" });
  });
  it("forces a full run at least hourly", () => {
    expect(decide(state({ fullRunAt: "2026-10-13T10:59:00Z" }), "sig", now)).toMatchObject({ build: true, reason: "hourly" });
  });
  it("keeps summarising while threads are waiting, without rebuilding", () => {
    expect(decide(state({ pendingSummaries: 3 }), "sig", now)).toMatchObject({ build: false, summarize: true });
  });
  it("waits out a backoff, then retries", () => {
    expect(decide(state({ nextRetryAt: "2026-10-13T12:30:00Z" }), "sig", now).summarize).toBe(false);
    expect(decide(state({ nextRetryAt: "2026-10-13T11:59:00Z" }), "sig", now).summarize).toBe(true);
  });
});
