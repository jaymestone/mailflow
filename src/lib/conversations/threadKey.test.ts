import { describe, expect, it } from "vitest";
import { normalizeSubject, pickCounterpart, threadKeyFor } from "./threadKey";

describe("normalizeSubject", () => {
  it("strips a reply prefix", () => {
    expect(normalizeSubject("Re: New Roster X Mountain Music")).toBe("new roster x mountain music");
  });

  it("strips stacked and mixed prefixes", () => {
    expect(normalizeSubject("RE: Fwd: Re: The Little Mercies")).toBe("the little mercies");
    expect(normalizeSubject("Fw: RE: Gasparilla")).toBe("gasparilla");
  });

  it("strips the numbered form some clients emit", () => {
    expect(normalizeSubject("Re[2]: Boats and Bluegrass")).toBe("boats and bluegrass");
  });

  it("strips non-English prefixes", () => {
    // Danish/Swedish (SV), German (AW) -- both turn up from European venues.
    expect(normalizeSubject("SV: Spot Festival")).toBe("spot festival");
    expect(normalizeSubject("AW: Rudolstadt")).toBe("rudolstadt");
  });

  it("collapses rewrapped whitespace", () => {
    expect(normalizeSubject("New Roster   X\n  Bluebird")).toBe("new roster x bluebird");
  });

  it("does not strip a subject that merely starts with those letters", () => {
    expect(normalizeSubject("Residency at the Ark")).toBe("residency at the ark");
    expect(normalizeSubject("Reunion Festival")).toBe("reunion festival");
  });

  it("handles a null or empty subject", () => {
    expect(normalizeSubject(null)).toBe("");
    expect(normalizeSubject("   ")).toBe("");
  });
});

describe("threadKeyFor", () => {
  it("gives the two halves of a split Gmail thread the same key", () => {
    // The real Carey Eyer case: two thread ids one character apart.
    const a = threadKeyFor("carey.eyer@gmail.com", "The Little Mercies");
    const b = threadKeyFor("Carey.Eyer@gmail.com", "Re: The Little Mercies");
    expect(a).toBe(b);
  });

  it("merges a duplicate whose thread ids look nothing alike", () => {
    // Peter Cutler / Mountain Music: 1a0abce591e38a8e vs 1a0efbb1fe86e42f.
    expect(threadKeyFor("petercutler65@gmail.com", "New Roster X Mountain Music")).toBe(
      threadKeyFor("petercutler65@gmail.com", "RE: New Roster X Mountain Music"),
    );
  });

  it("keeps different venues apart even on an identical subject", () => {
    expect(threadKeyFor("a@venue.org", "New Roster")).not.toBe(threadKeyFor("b@venue.org", "New Roster"));
  });

  it("keeps different enquiries from the same venue apart", () => {
    expect(threadKeyFor("a@venue.org", "Summer series")).not.toBe(threadKeyFor("a@venue.org", "Winter series"));
  });
});

describe("pickCounterpart", () => {
  const own = new Set(["stone@jaymestone.com", "agency@jaymestone.com"]);

  it("picks the venue over our own addresses, whatever the order", () => {
    expect(pickCounterpart(["stone@jaymestone.com", "booker@venue.org"], own)).toBe("booker@venue.org");
    expect(pickCounterpart(["booker@venue.org", "agency@jaymestone.com"], own)).toBe("booker@venue.org");
  });

  it("is case-insensitive about our own addresses", () => {
    expect(pickCounterpart(["Stone@JaymeStone.com", "booker@venue.org"], own)).toBe("booker@venue.org");
  });

  it("falls back to the first address when every participant is ours", () => {
    // An internal forward. Returning null would collapse every such
    // thread into a single conversation row.
    expect(pickCounterpart(["stone@jaymestone.com", "agency@jaymestone.com"], own)).toBe("stone@jaymestone.com");
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickCounterpart([], own)).toBeNull();
  });
});
