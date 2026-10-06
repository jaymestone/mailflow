import { describe, expect, it } from "vitest";
import { isSameVenue, speaksForVenue } from "./venueColleagues";

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

  it("matches an organisational domain in the same city despite different venue names", () => {
    expect(
      isSameVenue(
        c("wurl2@illinois.edu", "Krannert Center for the Performing Arts", "Urbana"),
        c("vklane2@illinois.edu", "Krannert Center", "Urbana"),
      ),
    ).toBe(true);
  });

  it("never matches on a shared free-mail domain", () => {
    expect(
      isSameVenue(c("a@gmail.com", "Old Sloop Presents", "Rockport"), c("b@gmail.com", "Rockport Music", "Rockport")),
    ).toBe(false);
  });

  it("does not match a shared domain without a city on both sides", () => {
    expect(isSameVenue(c("a@umd.edu", "School of Music"), c("b@umd.edu", "Clarice Smith Performing Arts Center"))).toBe(
      false,
    );
  });

  it("does not match two blank venues", () => {
    expect(isSameVenue(c("a@x.org", null), c("b@y.org", null))).toBe(false);
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
