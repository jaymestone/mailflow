import { describe, expect, it } from "vitest";
import { regionFor } from "./region";

describe("regionFor", () => {
  it("maps two-letter US states", () => {
    expect(regionFor("TX", "United States")).toBe("Southwest");
    expect(regionFor("WA", "United States")).toBe("West Coast");
    expect(regionFor("NY", "United States")).toBe("Northeast");
    expect(regionFor("KY", "United States")).toBe("Southeast");
    expect(regionFor("CO", "United States")).toBe("Mountain West");
    expect(regionFor("WI", "United States")).toBe("Midwest");
  });

  it("maps full state names, which some imports used", () => {
    expect(regionFor("Pennsylvania", "United States")).toBe("Northeast");
    expect(regionFor("north carolina", "USA")).toBe("Southeast");
  });

  it("puts Canada in Canada regardless of province", () => {
    // The important case: several provinces share abbreviations with US
    // states, so a province read as a state would land in a US region.
    expect(regionFor("ON", "Canada")).toBe("Canada");
    expect(regionFor("BC", "Canada")).toBe("Canada");
    expect(regionFor("NB", "Canada")).toBe("Canada");
    expect(regionFor("Nova Scotia", "Canada")).toBe("Canada");
  });

  it("recognises European countries", () => {
    expect(regionFor(null, "Denmark")).toBe("Europe");
    expect(regionFor("", "United Kingdom")).toBe("Europe");
  });

  it("falls back to Other for the '--' placeholder and for blanks", () => {
    expect(regionFor("--", "USA")).toBe("Other");
    expect(regionFor(null, null)).toBe("Other");
    expect(regionFor("  ", "United States")).toBe("Other");
  });

  it("falls back to Other for an unrecognised state", () => {
    expect(regionFor("Eastern US", "USA")).toBe("Other");
    expect(regionFor("ZZ", "USA")).toBe("Other");
  });
});
