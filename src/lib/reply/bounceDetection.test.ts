import { describe, expect, it } from "vitest";
import { classifyBounce, isBounceMessage } from "./bounceDetection";

describe("classifyBounce", () => {
  it("classifies a 5.x.x SMTP code as a hard bounce", () => {
    const result = classifyBounce({
      fromEmail: "mailer-daemon@example.com",
      subject: "Undeliverable: your message",
      bodyText: "550 5.1.1 The email account that you tried to reach does not exist.",
    });
    expect(result).toEqual({ isBounce: true, isHard: true });
  });

  it("classifies terminal body language as a hard bounce even without an explicit code", () => {
    const result = classifyBounce({
      fromEmail: "postmaster@example.com",
      subject: "Delivery Status Notification (Failure)",
      bodyText: "The recipient's mailbox is unavailable: no such user here.",
    });
    expect(result).toEqual({ isBounce: true, isHard: true });
  });

  it("classifies a 4.x.x SMTP code as a soft bounce, not deletable", () => {
    const result = classifyBounce({
      fromEmail: "mailer-daemon@example.com",
      subject: "Delivery Status Notification (Delay)",
      bodyText: "452 4.2.2 The email account that you tried to reach is over quota.",
    });
    expect(result).toEqual({ isBounce: true, isHard: false });
  });

  it("classifies mailbox-full language as a soft bounce", () => {
    const result = classifyBounce({
      fromEmail: "mailer-daemon@example.com",
      subject: "Mail delivery failed: returning message to sender",
      bodyText: "Your message could not be delivered because the mailbox is full. We will try again later.",
    });
    expect(result).toEqual({ isBounce: true, isHard: false });
  });

  it("treats an ambiguous DSN with no explicit hard or soft signal as soft, not hard", () => {
    const result = classifyBounce({
      fromEmail: "mailer-daemon@example.com",
      subject: "Undeliverable: your message",
      bodyText: "Delivery has failed. See technical details below.",
    });
    expect(result).toEqual({ isBounce: true, isHard: false });
  });

  it("does not classify a normal human reply as a bounce", () => {
    const result = classifyBounce({
      fromEmail: "booker@venue.com",
      subject: "Re: your outreach",
      bodyText: "Thanks for reaching out, let's set up a call next week.",
    });
    expect(result).toEqual({ isBounce: false, isHard: false });
  });

  it("prefers hard when both hard and soft signals are present", () => {
    const result = classifyBounce({
      fromEmail: "mailer-daemon@example.com",
      subject: "Delivery Status Notification (Failure)",
      bodyText: "550 5.1.1 no such user here. (Some recipients also saw 452 4.2.2 mailbox full.)",
    });
    expect(result).toEqual({ isBounce: true, isHard: true });
  });
});

describe("isBounceMessage", () => {
  it("returns true for any bounce regardless of hard/soft", () => {
    expect(
      isBounceMessage({
        fromEmail: "mailer-daemon@example.com",
        subject: "Delivery Status Notification (Delay)",
        bodyText: "452 4.2.2 mailbox full, try again later.",
      }),
    ).toBe(true);
  });

  it("returns false for a non-bounce", () => {
    expect(
      isBounceMessage({
        fromEmail: "booker@venue.com",
        subject: "Re: your outreach",
        bodyText: "Sounds great, let's talk.",
      }),
    ).toBe(false);
  });
});
