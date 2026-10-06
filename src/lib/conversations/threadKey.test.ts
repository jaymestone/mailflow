import { describe, expect, it } from "vitest";
import { normalizeSubject, pickCounterpart, threadRootId, threadKeyFor } from "./threadKey";

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

  it("strips the tags venues' mail servers add, in any order with reply prefixes", () => {
    for (const s of [
      "[EXTERNAL] Re: New Roster X Bo Diddley Plaza",
      "[External]:Re: New Roster X Bo Diddley Plaza",
      "[external]re: New Roster X Bo Diddley Plaza",
      "***SPAM*** Fwd: FW: New Roster X Bo Diddley Plaza",
      "[spam] Re: New Roster X Bo Diddley Plaza",
      "Re: **EXT** Re: New Roster X Bo Diddley Plaza",
      "[Use caution when clicking links - 109] RE: New Roster X Bo Diddley Plaza",
    ]) {
      expect(normalizeSubject(s), s).toBe("new roster x bo diddley plaza");
    }
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

  it("returns null when every participant is ours", () => {
    expect(pickCounterpart(["stone@jaymestone.com", "agency@jaymestone.com"], own)).toBeNull();
  });

  it("treats any address at Jayme's domains as his, connected or not", () => {
    expect(pickCounterpart(["admin@jaymestone.com", "j@jaymestoneagency.com", "booker@venue.org"], own)).toBe(
      "booker@venue.org",
    );
    expect(pickCounterpart(["admin@jaymestone.com"], own)).toBeNull();
  });

  it("takes the first outside participant, oldest message first", () => {
    expect(pickCounterpart(["a@venue.org", "b@venue.org"], own)).toBe("a@venue.org");
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickCounterpart([], own)).toBeNull();
  });
});

describe("threadRootId", () => {
  it("takes the first Message-ID in References, lowercased", () => {
    expect(threadRootId("<Root@mail.gmail.com> <second@x.com>", "<second@x.com>")).toBe("<root@mail.gmail.com>");
  });

  it("falls back to In-Reply-To when References is missing", () => {
    expect(threadRootId(null, "<only@x.com>")).toBe("<only@x.com>");
  });

  it("returns null when neither header has a Message-ID", () => {
    expect(threadRootId("", null)).toBeNull();
    expect(threadRootId("garbage", "also garbage")).toBeNull();
  });
});
