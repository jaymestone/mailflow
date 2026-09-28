import { describe, it, expect } from "vitest";
import { extractQuotedRecipients } from "./quotedRecipient";

// The live failure, reconstructed from inbound_messages row
// 8a329286-c043-4198-9828-d2c20eabb93e.
const MONA = `Jayme,

I retired Second Wind Productions in 2004 to concentrate on Music Haven.

Lily Henley just performed there with the John Doyle Quartet in early August.

I'll take a look at your roster...

Thanks,
MJG

From: Jayme Stone <agency@jaymestone.com>
Sent: Wednesday, September 16, 2026 9:25 AM
To: monag@pricechopper.com
Subject: New Roster X Second Wind Productions

Information: Forwarded from pricechopper.com.

Hi Mona,

Hope you're thriving.`;

describe("extractQuotedRecipients", () => {
  it("recovers the forwarded-to address the reply is actually answering", () => {
    expect(extractQuotedRecipients(MONA, ["mgolub@northeastsharedservices.com"])).toEqual([
      "monag@pricechopper.com",
    ]);
  });

  it("ignores a To: line above the quote, which is the human's own writing", () => {
    // "send it To: someone@else.org" in the reply body is a new instruction,
    // not a record of where our message landed.
    const body = "Please send it To: someone@else.org from now on.\n\nThanks";
    expect(extractQuotedRecipients(body, [])).toEqual([]);
  });

  it("reads the Gmail-style 'On ... wrote:' quote marker too", () => {
    const body =
      "Not for us, thanks.\n\nOn Wed, Sep 16, 2026 at 9:25 AM Jayme Stone <agency@jaymestone.com> wrote:\n" +
      "> To: booking@venue.org\n> Subject: New Roster";
    expect(extractQuotedRecipients(body, ["someone@venue.org"])).toEqual(["booking@venue.org"]);
  });

  it("reads an Outlook forwarded-message block", () => {
    const body =
      "See below.\n\n-----Original Message-----\nFrom: Jayme Stone\nTo: press@outlet.com\nSubject: hi";
    expect(extractQuotedRecipients(body, [])).toEqual(["press@outlet.com"]);
  });

  it("picks up Cc as well as To", () => {
    const body = "ok\n\nFrom: Jayme\nTo: a@venue.org\nCc: b@venue.org\nSubject: x";
    expect(extractQuotedRecipients(body, [])).toEqual(["a@venue.org", "b@venue.org"]);
  });

  it("excludes the addresses it is told to, so the sender never matches itself", () => {
    const body = "ok\n\nFrom: Jayme\nTo: mona@venue.org\nSubject: x";
    expect(extractQuotedRecipients(body, ["MONA@venue.org"])).toEqual([]);
  });

  it("drops infrastructure addresses that cannot be a contact", () => {
    const body = "ok\n\nFrom: Jayme\nTo: no-reply@venue.org, real@venue.org\nSubject: x";
    expect(extractQuotedRecipients(body, [])).toEqual(["real@venue.org"]);
  });

  it("handles a display-name wrapped address", () => {
    const body = 'ok\n\nFrom: Jayme\nTo: "Golub, Mona" <monag@pricechopper.com>\nSubject: x';
    expect(extractQuotedRecipients(body, [])).toEqual(["monag@pricechopper.com"]);
  });

  it("returns nothing when there is no quoted block at all", () => {
    expect(extractQuotedRecipients("Sure, send more info.", [])).toEqual([]);
  });

  it("does not duplicate an address repeated down a long quoted chain", () => {
    const body =
      "ok\n\nFrom: Jayme\nTo: a@venue.org\nSubject: x\n\nFrom: Jayme\nTo: a@venue.org\nSubject: x";
    expect(extractQuotedRecipients(body, [])).toEqual(["a@venue.org"]);
  });

  it("tolerates an empty or missing body", () => {
    expect(extractQuotedRecipients("", [])).toEqual([]);
    expect(extractQuotedRecipients(undefined as unknown as string, [])).toEqual([]);
  });
});
