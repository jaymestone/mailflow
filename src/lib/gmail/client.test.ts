import { describe, expect, it } from "vitest";
import { formatFromAddress } from "./client";

describe("formatFromAddress", () => {
  it("formats a display name and email as a quoted address", () => {
    expect(formatFromAddress("Jayme Stone", "j@jaymestoneagency.com")).toBe(
      '"Jayme Stone" <j@jaymestoneagency.com>',
    );
  });

  it("falls back to a bare email when there is no display name", () => {
    expect(formatFromAddress(null, "j@jaymestoneagency.com")).toBe("j@jaymestoneagency.com");
  });

  it("falls back to a bare email when the display name is blank", () => {
    expect(formatFromAddress("   ", "j@jaymestoneagency.com")).toBe("j@jaymestoneagency.com");
  });

  it("escapes an embedded double quote in the display name", () => {
    expect(formatFromAddress('Jayme "The Agent" Stone', "j@x.com")).toBe(
      '"Jayme \\"The Agent\\" Stone" <j@x.com>',
    );
  });
});
