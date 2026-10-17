import { describe, expect, it } from "vitest";
import { dueActions, type ScheduledAction } from "./actions";

const base = { label: "x", createdAt: "2026-10-16T00:00:00Z", type: "activate_campaign" as const, params: { campaignId: "c" } };

describe("dueActions", () => {
  const now = new Date("2026-10-19T15:00:00Z");

  it("returns pending actions whose time has come, oldest first", () => {
    const a: ScheduledAction[] = [
      { ...base, id: "late", runAt: "2026-10-19T14:30:00Z", status: "pending" },
      { ...base, id: "early", runAt: "2026-10-19T14:00:00Z", status: "pending" },
    ];
    expect(dueActions(a, now).map((x) => x.id)).toEqual(["early", "late"]);
  });

  it("skips future, done and failed actions", () => {
    const a: ScheduledAction[] = [
      { ...base, id: "future", runAt: "2026-10-29T15:00:00Z", status: "pending" },
      { ...base, id: "done", runAt: "2026-10-19T14:00:00Z", status: "done" },
      { ...base, id: "failed", runAt: "2026-10-19T14:00:00Z", status: "failed" },
    ];
    expect(dueActions(a, now)).toEqual([]);
  });

  it("treats an action due exactly now as due", () => {
    const a: ScheduledAction[] = [{ ...base, id: "now", runAt: now.toISOString(), status: "pending" }];
    expect(dueActions(a, now).map((x) => x.id)).toEqual(["now"]);
  });
});
