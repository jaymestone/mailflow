import { describe, expect, it } from "vitest";
import { isSameVenue, programsIndependently, speaksForVenue } from "./venueColleagues";

const c = (email: string, venue: string | null, city: string | null = null, state: string | null = null) => ({
  email,
  venue,
  city,
  state,
});

describe("isSameVenue", () => {
  it("matches colleagues filed under the same venue", () => {
    expect(isSameVenue(c("edithgb@tamu.edu", "Texas A&M"), c("sshafer@tamu.edu", "Texas A&M"))).toBe(true);
  });

  it("ignores case, accents, punctuation and a leading 'The'", () => {
    expect(isSameVenue(c("maria@tf.dk", "Tønder Festival"), c("x@y.dk", "Tonder Festival"))).toBe(true);
    expect(isSameVenue(c("a@wolftrap.org", "Wolf Trap"), c("b@other.org", "The Wolf Trap"))).toBe(true);
  });

  it("keeps same-named venues in different places apart", () => {
    expect(
      isSameVenue(
        c("robert.tombari@cityoftracy.org", "Grand Theatre", "Tracy", "CA"),
        c("stacyleighbarnes@gmail.com", "Grand Theatre", "Frankfort", "KY"),
      ),
    ).toBe(false);
    expect(
      isSameVenue(
        c("rob@capitoltheatre.com", "Capitol Theatre", "Port Hope", "ON"),
        c("capitolexecutivedirector@gmail.com", "Capitol Theatre", null, "BC"),
      ),
    ).toBe(false);
  });

  it("treats a blank city as agreeing", () => {
    expect(isSameVenue(c("a@x.org", "Rockport Music", "Rockport", "MA"), c("b@x.org", "Rockport Music"))).toBe(true);
  });

  it("does not treat a shared organisational domain as the same venue", () => {
    expect(
      isSameVenue(
        c("barneshd@wfu.edu", "Secrest Artists Series", "Winston-Salem"),
        c("sorianct@wfu.edu", "Wake Forest University", "Winston-Salem"),
      ),
    ).toBe(false);
  });

  it("does not match two blank venues", () => {
    expect(isSameVenue(c("a@x.org", null), c("b@y.org", null))).toBe(false);
  });
});

describe("programsIndependently", () => {
  it("is true for Lincoln Center, however the name is spaced or cased", () => {
    expect(programsIndependently("Lincoln Center for the Performing Arts")).toBe(true);
    expect(programsIndependently("lincoln center for the performing arts ")).toBe(true);
  });

  it("is false for other venues, including other Lincoln Centers", () => {
    expect(programsIndependently("Lincoln Center - Fort Collins")).toBe(false);
    expect(programsIndependently("Jazz at Lincoln Center")).toBe(false);
    expect(programsIndependently("Texas A&M")).toBe(false);
    expect(programsIndependently(null)).toBe(false);
  });
});

describe("speaksForVenue", () => {
  it("is true for replies a person wrote", () => {
    for (const k of ["interested", "not_interested", "follow_up", "opt_out"] as const) expect(speaksForVenue(k)).toBe(true);
  });

  it("is false for auto-replies, bounces, spam and unclear (e.g. 'wrong person')", () => {
    for (const k of ["ooo_temporary", "ooo_departed", "bounce", "spam", "unclear"] as const)
      expect(speaksForVenue(k)).toBe(false);
  });
});
