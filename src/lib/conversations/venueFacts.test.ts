import { describe, expect, it } from "vitest";
import { mergeVenueFacts } from "./venueFacts";

describe("mergeVenueFacts", () => {
  it("adds a facts block below existing notes, leaving them intact", () => {
    expect(mergeVenueFacts("Met at APAP.", ["Capacity 300", "Summer series only (June–Aug)"])).toBe(
      "Met at APAP.\n\nVenue facts:\n- Capacity 300\n- Summer series only (June–Aug)",
    );
  });
  it("starts a block when there are no notes", () => {
    expect(mergeVenueFacts(null, ["Rental venue only"])).toBe("Venue facts:\n- Rental venue only");
  });
  it("skips facts already recorded, ignoring case and punctuation", () => {
    const n = "Venue facts:\n- Capacity 300";
    expect(mergeVenueFacts(n, ["capacity 300.", "Budget $1,500–$4,000"])).toBe("Venue facts:\n- Capacity 300\n- Budget $1,500–$4,000");
  });
  it("leaves notes unchanged when nothing new", () => {
    expect(mergeVenueFacts("x", [])).toBe("x");
    expect(mergeVenueFacts("Venue facts:\n- Capacity 300", ["Capacity 300"])).toBe("Venue facts:\n- Capacity 300");
  });
});
