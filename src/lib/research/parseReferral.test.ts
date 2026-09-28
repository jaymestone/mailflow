import { describe, it, expect } from "vitest";
import { parseReferral, topOfReply } from "./parseReferral";

// Every body below is real text from the list, trimmed.

describe("parseReferral", () => {
  it("takes the named successor a bounce points at", () => {
    const r = parseReferral(
      "Hello! Thank you for your email. I am out of the office until Monday, September 21, 2026. " +
        "Please reach out to Matt Dettmer (mdettmer@warnertheatre.org), should you need immediate assistance. Best, Charlene",
      { senderEmail: "cspeyerer@bushnell.org" },
    );

    expect(r?.email).toBe("mdettmer@warnertheatre.org");
    expect(r?.name).toBe("Matt Dettmer");
    // Different domain, so medium rather than high.
    expect(r?.confidence).toBe("medium");
  });

  it("prefers a named colleague at the same organisation over a role address", () => {
    const r = parseReferral(
      "Many thanks for your email. Please note that I am no longer with Mwldan. " +
        "For programming please contact claire@mwldan.co.uk or marketing@mwldan.co.uk.",
      { senderEmail: "dilwyn@mwldan.co.uk" },
    );

    expect(r?.email).toBe("claire@mwldan.co.uk");
    expect(r?.confidence).toBe("high");
    expect(r?.isRoleAddress).toBe(false);
  });

  it("accepts a role address when that is all the venue offers", () => {
    const r = parseReferral(
      "This mailbox is no longer monitored. For all enquiries please email info@englert.org.",
      { senderEmail: "catch@englert.org" },
    );

    expect(r?.email).toBe("info@englert.org");
    expect(r?.isRoleAddress).toBe(true);
    expect(r?.confidence).toBe("high");
  });

  it("returns null when a reply promises a handover but names no address", () => {
    // "I'm cc'ing our booking team who can help you further" -- there is
    // nothing here to mail, and inventing one would be worse than nothing.
    const r = parseReferral(
      "Hey Jayme, Thank you for reaching out! I'm cc'ing our booking team who can help you further",
      { senderEmail: "info@revivalavl.com" },
    );

    expect(r).toBeNull();
  });

  it("never refers to the sender's own address", () => {
    const r = parseReferral(
      "Thank you for your email. Please contact me at dilwyn@mwldan.co.uk for anything urgent.",
      { senderEmail: "dilwyn@mwldan.co.uk" },
    );

    expect(r).toBeNull();
  });

  it("ignores our own addresses quoted back at us", () => {
    const r = parseReferral(
      "I am no longer with the theatre. Please contact stone@jaymestone.com — no wait, that's you.",
      { senderEmail: "someone@venue.org" },
    );

    expect(r).toBeNull();
  });

  it("ignores no-reply and infrastructure addresses", () => {
    const r = parseReferral(
      "I have left the organisation. Please contact no-reply@venue.org or admin@list-manage.com.",
      { senderEmail: "gone@venue.org" },
    );

    expect(r).toBeNull();
  });

  it("does not treat a signature address as a referral", () => {
    // A colleague's address in a footer, with no phrase handing anything
    // over, is not a referral. Two candidates and no pointer = decline.
    const r = parseReferral(
      "Thanks for your email, I'll take a look next week. Best, Sam\n" +
        "Sam Baijal | Hillside Festival | sbaijal@hillsidefestival.ca | office: admin@hillsidefestival.ca",
      { senderEmail: "sam.personal@gmail.com" },
    );

    expect(r).toBeNull();
  });

  it("accepts a lone same-organisation address with no pointer, at low confidence", () => {
    const r = parseReferral("I have retired. The office can help: boxoffice@lobero.org", {
      senderEmail: "dasbell@lobero.org",
    });

    // "can help" is not in the pointer list, so this falls through to the
    // lone-same-org rule.
    expect(r?.email).toBe("boxoffice@lobero.org");
    expect(r?.confidence).toBe("low");
  });

  it("picks the successor named after the pointer, not an earlier address", () => {
    const r = parseReferral(
      "Regarding your note to jillkopecky@livenation.com — Jill has left. " +
        "Please reach out to Mallory Wright at mallorywright@livenation.com going forward.",
      { senderEmail: "jillkopecky@livenation.com" },
    );

    expect(r?.email).toBe("mallorywright@livenation.com");
    expect(r?.name).toBe("Mallory Wright");
  });

  it("handles the UMass case, several colleagues after one pointer", () => {
    const r = parseReferral(
      "I am no longer at UMass. For venue enquiries please contact pvenu@umass.edu, " +
        "or hrathbun@admin.umass.edu for contracts.",
      { senderEmail: "michaelsakam@umass.edu" },
    );

    // pvenu@umass.edu is same-domain and closest to the pointer.
    expect(r?.email).toBe("pvenu@umass.edu");
    expect(r?.confidence).toBe("high");
  });

  it("reads through an HTML body", () => {
    const r = parseReferral(
      '<div dir="ltr"><p>Hello,</p><p>I have moved on. Please contact ' +
        '<a href="mailto:newperson@venue.org">newperson@venue.org</a>.</p></div>',
      { senderEmail: "old@venue.org" },
    );

    expect(r?.email).toBe("newperson@venue.org");
  });

  it("does not mine the quoted thread below the reply", () => {
    // Jayme's own signature and every prior address live down there.
    const r = parseReferral(
      "I've left, sorry.\n\nOn Wed, Sep 16, 2026 at 2:15 PM Jayme Stone wrote:\n> Please contact booking@somewhere.org",
      { senderEmail: "gone@venue.org" },
    );

    expect(r).toBeNull();
  });

  it("carries evidence so a human can check the call", () => {
    const r = parseReferral(
      "I am no longer with the City of Pocatello. For assistance, please contact the Parks Department at parks@pocatello.us.",
      { senderEmail: "jbanks@pocatello.gov" },
    );

    expect(r?.evidence).toContain("parks@pocatello.us");
  });
});

describe("topOfReply", () => {
  it("cuts at the quoted history", () => {
    expect(topOfReply("Alive\n\nOn Mon, Jan 1, 2026 at 9:00 AM Someone wrote:\nDead")).toContain("Alive");
    expect(topOfReply("Alive\n\nOn Mon, Jan 1, 2026 at 9:00 AM Someone wrote:\nDead")).not.toContain("Dead");
  });

  it("drops mailto wrappers that duplicate every address", () => {
    expect(topOfReply("write to a@b.org<mailto:a@b.org>")).toBe("write to a@b.org ");
  });
});
