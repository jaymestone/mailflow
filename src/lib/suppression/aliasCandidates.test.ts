import { describe, it, expect } from "vitest";
import { matchAliases } from "./aliasCandidates";

const contact = (id: string, email: string, first: string | null, last: string | null, venue: string) => ({
  id,
  email,
  first_name: first,
  last_name: last,
  venue,
});

describe("matchAliases", () => {
  it("catches the Peabody case: same person, old domain still in the list", () => {
    // The real failure. Jayme supplied the reply address; the list held the
    // old City of Daytona Beach domain, which is what the send engine
    // actually gates on.
    const warnings = matchAliases(
      ["SmithChad@daytonabeach.gov"],
      [contact("c1", "SmithChad@codb.us", "Chad", "Smith", "Peabody Auditorium")],
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0].candidates).toEqual([
      { contactId: "c1", email: "SmithChad@codb.us", name: "Chad Smith", venue: "Peabody Auditorium", match: "exact" },
    ]);
  });

  it("catches the Rubin Museum case regardless of which address came first", () => {
    const warnings = matchAliases(
      ["tmchenry@rubinmuseum.org"],
      [contact("c1", "tmchenry@rmanyc.org", "Tim", "McHenry", "Rubin Museum Concerts")],
    );

    expect(warnings[0].candidates[0].email).toBe("tmchenry@rmanyc.org");
  });

  it("matches across the first.last vs firstlast convention change", () => {
    const warnings = matchAliases(
      ["chad.smith@newdomain.org"],
      [contact("c1", "chadsmith@olddomain.org", "Chad", "Smith", "Somewhere")],
    );

    expect(warnings[0].candidates[0].match).toBe("loose");
  });

  it("stays quiet when the only match is on the same domain", () => {
    // A colleague at the same domain is not an alias of this person, and
    // the same address is obviously not either.
    const warnings = matchAliases(
      ["tmchenry@rmanyc.org"],
      [
        contact("c1", "tmchenry@rmanyc.org", "Tim", "McHenry", "Rubin"),
        contact("c2", "programming@rmanyc.org", "Dawn", "Eshelman", "Rubin"),
      ],
    );

    expect(warnings).toEqual([]);
  });

  it("does not flag an address already in the same suppression batch", () => {
    // When both addresses are being suppressed together -- which is what I
    // now do by hand -- there is nothing left to warn about.
    const warnings = matchAliases(
      ["SmithChad@daytonabeach.gov", "SmithChad@codb.us"],
      [contact("c1", "SmithChad@codb.us", "Chad", "Smith", "Peabody Auditorium")],
    );

    expect(warnings).toEqual([]);
  });

  it("ignores role accounts, which would otherwise match each other en masse", () => {
    // 6,000 contacts contain a great many info@ addresses. Matching on the
    // local part there would flag every venue against every other venue.
    const warnings = matchAliases(
      ["info@onevenue.org"],
      [
        contact("c1", "info@anothervenue.org", null, null, "Another Venue"),
        contact("c2", "booking@thirdvenue.org", null, null, "Third Venue"),
      ],
    );

    expect(warnings).toEqual([]);
  });

  it("reports several candidates when a person appears on more than one old domain", () => {
    const warnings = matchAliases(
      ["jsmith@current.org"],
      [
        contact("c1", "jsmith@old.org", "J", "Smith", "Venue A"),
        contact("c2", "j.smith@older.org", "J", "Smith", "Venue B"),
        contact("c3", "different@current.org", "Someone", "Else", "Venue C"),
      ],
    );

    expect(warnings[0].candidates.map((c) => c.email).sort()).toEqual(["j.smith@older.org", "jsmith@old.org"]);
  });

  it("does NOT flag bare first-name addresses at unrelated venues", () => {
    // The false positive that the live scan caught. Many venues use
    // firstname@venue.com, so "jeff" matching "jeff" says nothing about
    // whether it is the same Jeff. Eight unrelated Jeffs were flagged.
    const warnings = matchAliases(
      ["jeff@nelsonodeon.com"],
      [
        contact("c1", "jeff@grandstreettheatre.com", "Jeff", "Downing", "Grandstreet Theatre"),
        contact("c2", "jeff@kpcenter.org", "Jeff", "Lockhart", "Kirkland Performance Center"),
        contact("c3", "jeff@bentoff.com", "Jeff", "Bentoff", "Musical Mondays"),
      ],
    );

    expect(warnings).toEqual([]);
  });

  it("still flags a first-name address when the surname is in it", () => {
    // jeff@bentoff.com genuinely does carry Bentoff's surname, but in the
    // DOMAIN, not the local part -- so it must not match on that basis.
    const warnings = matchAliases(
      ["jbentoff@newvenue.org"],
      [contact("c1", "jbentoff@oldvenue.org", "Jeff", "Bentoff", "Musical Mondays")],
    );

    expect(warnings).toHaveLength(1);
  });

  it("skips candidates with no surname on record, which cannot be corroborated", () => {
    const warnings = matchAliases(
      ["kevin@somewhere.org"],
      [contact("c1", "kevin@elsewhere.org", "Kevin", null, "Doe Bay Fest")],
    );

    expect(warnings).toEqual([]);
  });

  it("ignores a surname too short to be distinctive inside a longer local part", () => {
    // "ng" appearing in "armstrong" is coincidence, not identity.
    const warnings = matchAliases(
      ["armstrong@venue-a.org"],
      [contact("c1", "armstrong@venue-b.org", "Bill", "Ng", "Venue B")],
    );

    expect(warnings).toEqual([]);
  });

  it("returns nothing for an address with no counterpart, so callers stay silent", () => {
    const warnings = matchAliases(
      ["nobody@nowhere.org"],
      [contact("c1", "someone@elsewhere.org", "Someone", "Else", "Venue")],
    );

    expect(warnings).toEqual([]);
  });

  it("is case-insensitive on both sides", () => {
    const warnings = matchAliases(
      ["SMITHCHAD@DAYTONABEACH.GOV"],
      [contact("c1", "smithchad@codb.us", "Chad", "Smith", "Peabody")],
    );

    expect(warnings).toHaveLength(1);
  });
});
