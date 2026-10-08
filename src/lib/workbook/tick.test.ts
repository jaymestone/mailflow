import { describe, expect, it } from "vitest";
import { compactDays } from "./tick";

describe("compactDays", () => {
  it("drops weekdays and groups by month", () => {
    expect(compactDays(["2027-04-13", "2027-04-14", "2027-04-15", "2027-05-01"])).toBe("Apr 13, 14, 15 · May 1");
  });
});
