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
