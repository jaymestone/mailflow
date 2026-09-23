import { describe, expect, it, vi } from "vitest";
import { findUnresolvedTokens, resolveMergeFields, resolveSpintext, resolveTemplate } from "./resolve";

describe("resolveMergeFields", () => {
  it("substitutes known fields", () => {
    const contact = { first_name: "Jayme", venue: "The Fillmore" };
    expect(resolveMergeFields("Hi {{First Name}}, love {{Venue}}", contact)).toBe("Hi Jayme, love The Fillmore");
  });

  it("is case-insensitive and trims whitespace inside the braces", () => {
    const contact = { first_name: "Jayme" };
    expect(resolveMergeFields("{{ first name }}", contact)).toBe("Jayme");
    expect(resolveMergeFields("{{FIRST NAME}}", contact)).toBe("Jayme");
  });

  it("falls back to the field's default when the contact value is missing or blank", () => {
    expect(resolveMergeFields("{{First Name}}", {})).toBe("there");
    expect(resolveMergeFields("{{Venue}}", { venue: "   " })).toBe("your venue");
    expect(resolveMergeFields("{{Last Name}}", {})).toBe("");
  });

  it("prefers venue_short over venue, so catalogue names never reach the copy", () => {
    // The real case this exists for: a name that is correct in the list
    // and unsayable in a sentence.
    const contact = { venue: "World Music/CRASHarts", venue_short: "CRASHarts" };
    expect(resolveMergeFields("good for {{Venue}}", contact)).toBe("good for CRASHarts");
  });

  it("falls back to venue when no short form is set", () => {
    // ~98% of names read fine as-is and are meant to need no attention.
    expect(resolveMergeFields("{{Venue}}", { venue: "The Fillmore" })).toBe("The Fillmore");
    expect(resolveMergeFields("{{Venue}}", { venue: "The Fillmore", venue_short: "  " })).toBe("The Fillmore");
    expect(resolveMergeFields("{{Venue}}", { venue: "The Fillmore", venue_short: null })).toBe("The Fillmore");
  });

  it("still reaches the generic default when neither form is set", () => {
    expect(resolveMergeFields("{{Venue}}", { venue: null, venue_short: null })).toBe("your venue");
  });

  it("writes the clicked artists the way a person lists names", () => {
    const one = { clicked_artists: ["Summer Camargo"] };
    const two = { clicked_artists: ["Summer Camargo", "Rakish"] };
    const three = { clicked_artists: ["Summer Camargo", "Rakish", "Lily Henley"] };

    expect(resolveMergeFields("{{Clicked Artists}}", one)).toBe("Summer Camargo");
    expect(resolveMergeFields("{{Clicked Artists}}", two)).toBe("Summer Camargo and Rakish");
    // No Oxford comma, matching Jayme's own "roots, jazz and world music".
    expect(resolveMergeFields("{{Clicked Artists}}", three)).toBe("Summer Camargo, Rakish and Lily Henley");
  });

  it("leaves {{Clicked Artists}} unresolved when there are none, so the send is skipped", () => {
    // Every other field degrades gracefully; this one must not. A blank
    // would read "I think  could be especially good for you", and any
    // filler would assert behaviour that never happened. Leaving the token
    // intact makes findUnresolvedTokens trip and the send engine skip.
    expect(findUnresolvedTokens(resolveMergeFields("I think {{Clicked Artists}} suit you", {}))).not.toHaveLength(0);
    expect(findUnresolvedTokens(resolveMergeFields("{{Clicked Artists}}", { clicked_artists: [] }))).not.toHaveLength(
      0,
    );
  });

  it("leaves an unknown field name untouched", () => {
    expect(resolveMergeFields("{{Not A Field}}", {})).toBe("{{Not A Field}}");
  });

  it("does not touch single-brace spintext groups", () => {
    expect(resolveMergeFields("{a|b}", {})).toBe("{a|b}");
  });
});

describe("resolveSpintext", () => {
  it("picks one of the pipe-separated options", () => {
    const result = resolveSpintext("{a|b|c}");
    expect(["a", "b", "c"]).toContain(result);
  });

  it("resolves a single-option group to that option", () => {
    expect(resolveSpintext("{only}")).toBe("only");
  });

  it("resolves multiple independent groups in the same string", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(resolveSpintext("{a|b} and {c|d}")).toBe("a and c");
    vi.restoreAllMocks();
  });

  it("leaves plain text with no braces untouched", () => {
    expect(resolveSpintext("hello there")).toBe("hello there");
  });
});

describe("resolveTemplate", () => {
  it("resolves merge fields before spintext, so nested {{...}} is not misparsed as spintext", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const result = resolveTemplate("{{First Name}}", { first_name: "Jayme" });
    expect(result).toBe("Jayme");
    vi.restoreAllMocks();
  });

  it("resolves a merge field then spintext over the combined text", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = resolveTemplate("Hi {{First Name}}, {great|good} to meet you", { first_name: "Jayme" });
    expect(result).toBe("Hi Jayme, good to meet you");
    vi.restoreAllMocks();
  });
});

describe("findUnresolvedTokens", () => {
  it("returns an empty array when nothing is left unresolved", () => {
    expect(findUnresolvedTokens("plain text, no braces")).toEqual([]);
  });

  it("flags a leftover unknown merge field as its constituent brace tokens", () => {
    // The regex isn't brace-depth-aware, so a double-brace group is matched
    // as an outer stray "{", an inner "{Unknown Field}", and a stray "}" —
    // still non-empty, which is all callers actually check for.
    expect(findUnresolvedTokens("{{Unknown Field}}")).toEqual(["{", "{Unknown Field}", "}"]);
  });

  it("flags an unknown merge field surviving a full resolveTemplate pass", () => {
    const resolved = resolveTemplate("Hi {{Not A Field}}", {});
    expect(findUnresolvedTokens(resolved).length).toBeGreaterThan(0);
  });

  it("flags malformed spintext with a missing closing brace", () => {
    expect(findUnresolvedTokens("{a|b")).toEqual(["{a|b"]);
  });

  it("flags a stray closing brace", () => {
    expect(findUnresolvedTokens("hello}")).toEqual(["}"]);
  });
});
