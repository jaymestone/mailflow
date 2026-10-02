import { describe, expect, it } from "vitest";
import { isRoleAddress } from "./roleAddress";

describe("isRoleAddress", () => {
  it("recognises the address that caused this", () => {
    expect(isRoleAddress("festival@celticfestival.ca")).toBe(true);
  });

  it("recognises common shared mailboxes", () => {
    for (const e of [
      "info@venue.org", "booking@venue.org", "bookings@venue.org",
      "boxoffice@venue.org", "tickets@venue.org", "programming@venue.org",
      "press@venue.org", "office@venue.org", "submissions@venue.org",
    ]) {
      expect(isRoleAddress(e), e).toBe(true);
    }
  });

  it("recognises separated and suffixed forms", () => {
    expect(isRoleAddress("box.office@venue.org")).toBe(true);
    expect(isRoleAddress("booking-jazz@venue.org")).toBe(true);
    expect(isRoleAddress("tickets2026@venue.org")).toBe(true);
    expect(isRoleAddress("info.uk@venue.org")).toBe(true);
  });

  it("ignores case and plus-tags", () => {
    expect(isRoleAddress("Info+roster@Venue.org")).toBe(true);
  });

  it("treats a person's address as personal", () => {
    for (const e of [
      "sarah.jones@venue.org", "cprashker@aol.com", "wlr42@hotmail.com",
      "dawn@celtic-colours.com", "jean-philippe@festival-interceltique.bzh",
      "carey.eyer@gmail.com", "levi@levittarlington.org",
    ]) {
      expect(isRoleAddress(e), e).toBe(false);
    }
  });

  it("does not match a personal name that merely starts with a role word", () => {
    // "Marcus" starts with "ma", "Presley" with "press"? -- guard the real
    // risk: a first name that happens to begin with a listed prefix.
    expect(isRoleAddress("infante@venue.org")).toBe(false);
    expect(isRoleAddress("eventsonlyperson@venue.org")).toBe(true); // known trade-off, documented
  });

  it("handles junk input", () => {
    expect(isRoleAddress(null)).toBe(false);
    expect(isRoleAddress("")).toBe(false);
    expect(isRoleAddress("notanemail")).toBe(false);
    expect(isRoleAddress("@venue.org")).toBe(false);
  });
});
