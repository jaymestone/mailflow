import { describe, expect, it } from "vitest";
import { compactDays } from "./tick";

describe("compactDays", () => {
  it("drops weekdays and groups by month", () => {
    expect(compactDays(["2027-04-13", "2027-04-14", "2027-04-15", "2027-05-01"])).toBe("Apr 13, 14, 15 · May 1");
  });
});

describe("compactRange", async () => {
  const { compactRange } = await import("./tick");
  it("shows a run's dates without weekdays", () => {
    expect(compactRange("2027-03-17", "2027-03-17")).toBe("Mar 17");
    expect(compactRange("2027-05-21", "2027-05-23")).toBe("May 21–23");
    expect(compactRange("2027-04-30", "2027-05-02")).toBe("Apr 30–May 2");
  });
});
