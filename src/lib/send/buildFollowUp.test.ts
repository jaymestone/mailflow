import { describe, expect, it } from "vitest";
import { buildFollowUpContent, type PriorSend } from "./buildFollowUp";

function priorSend(overrides: Partial<PriorSend>): PriorSend {
  return {
    step_number: 1,
    subject_resolved: "New Artists X Example Venue",
    body_resolved: "Hi there,\n\nCheck out [this band](https://example.com/band).\n\nThanks,\nJayme",
    sent_at: "2026-08-21T18:53:00Z",
    rfc_message_id: "<step1@jaymestoneagency.com>",
    gmail_thread_id: "thread-1",
    connected_account_id: "account-1",
    connected_account: { email_address: "j@jaymestoneagency.com", display_name: "Jayme Stone" },
    ...overrides,
  };
}

describe("buildFollowUpContent", () => {
  it("leaves subject/body/htmlInner untouched for step 1 (nextStep === 1)", () => {
    const result = buildFollowUpContent({
      subject: "Hello",
      body: "Hi there",
      nextStep: 1,
      chain: [],
      currentAccountId: "account-1",
    });
    expect(result.finalSubject).toBe("Hello");
    expect(result.finalBody).toBe("Hi there");
    expect(result.htmlInner).toBe("Hi there");
    expect(result.inReplyTo).toBeUndefined();
    expect(result.references).toBeUndefined();
    expect(result.threadId).toBeUndefined();
  });

  it("fills a blank subject with 'Re: [step 1 subject]' on a follow-up step", () => {
    const result = buildFollowUpContent({
      subject: "",
      body: "Following up",
      nextStep: 2,
      chain: [priorSend({})],
      currentAccountId: "account-1",
    });
    expect(result.finalSubject).toBe("Re: New Artists X Example Venue");
  });

  it("does not override an explicitly-set subject on a follow-up step", () => {
    const result = buildFollowUpContent({
      subject: "A custom subject",
      body: "Following up",
      nextStep: 2,
      chain: [priorSend({})],
      currentAccountId: "account-1",
    });
    expect(result.finalSubject).toBe("A custom subject");
  });

  it("quotes step 1 specifically, not the immediately preceding step, on step 3+", () => {
    const step1 = priorSend({ step_number: 1, body_resolved: "STEP ONE BODY" });
    const step2 = priorSend({ step_number: 2, body_resolved: "STEP TWO BODY", rfc_message_id: "<step2@x>" });
    const result = buildFollowUpContent({
      subject: "",
      body: "Third message",
      nextStep: 3,
      chain: [step1, step2],
      currentAccountId: "account-1",
    });
    expect(result.finalBody).toContain("STEP ONE BODY");
    expect(result.finalBody).not.toContain("STEP TWO BODY");
    expect(result.htmlInner).toContain("STEP ONE BODY");
    expect(result.htmlInner).not.toContain("STEP TWO BODY");
  });

  it("quotes the plain-text body with '> ' prefixes and the HTML body as a real blockquote", () => {
    const result = buildFollowUpContent({
      subject: "",
      body: "New content",
      nextStep: 2,
      chain: [priorSend({ body_resolved: "line one\nline two" })],
      currentAccountId: "account-1",
    });
    expect(result.finalBody).toContain("> line one\n> line two");
    expect(result.htmlInner).toContain("<blockquote");
    expect(result.htmlInner).toContain("line one<br>line two");
  });

  it("linkifies markdown links inside the quoted body", () => {
    const result = buildFollowUpContent({
      subject: "",
      body: "New content",
      nextStep: 2,
      chain: [priorSend({ body_resolved: "[a link](https://example.com)" })],
      currentAccountId: "account-1",
    });
    expect(result.htmlInner).toContain('<a href="https://example.com">a link</a>');
  });

  it("builds References as the full ancestor chain, oldest first", () => {
    const step1 = priorSend({ step_number: 1, rfc_message_id: "<step1@x>" });
    const step2 = priorSend({ step_number: 2, rfc_message_id: "<step2@x>" });
    const result = buildFollowUpContent({
      subject: "",
      body: "Third message",
      nextStep: 3,
      chain: [step1, step2],
      currentAccountId: "account-1",
    });
    expect(result.references).toBe("<step1@x> <step2@x>");
  });

  it("sets In-Reply-To to the direct parent (most recent prior step), not step 1", () => {
    const step1 = priorSend({ step_number: 1, rfc_message_id: "<step1@x>" });
    const step2 = priorSend({ step_number: 2, rfc_message_id: "<step2@x>" });
    const result = buildFollowUpContent({
      subject: "",
      body: "Third message",
      nextStep: 3,
      chain: [step1, step2],
      currentAccountId: "account-1",
    });
    expect(result.inReplyTo).toBe("<step2@x>");
  });

  it("skips a prior step with no rfc_message_id when building the References chain", () => {
    const step1 = priorSend({ step_number: 1, rfc_message_id: null });
    const step2 = priorSend({ step_number: 2, rfc_message_id: "<step2@x>" });
    const result = buildFollowUpContent({
      subject: "",
      body: "Third message",
      nextStep: 3,
      chain: [step1, step2],
      currentAccountId: "account-1",
    });
    expect(result.references).toBe("<step2@x>");
  });

  it("leaves References/In-Reply-To undefined when the chain has no ids at all", () => {
    const result = buildFollowUpContent({
      subject: "",
      body: "Third message",
      nextStep: 2,
      chain: [priorSend({ rfc_message_id: null })],
      currentAccountId: "account-1",
    });
    expect(result.references).toBeUndefined();
    expect(result.inReplyTo).toBeUndefined();
  });

  it("reuses the Gmail thread id only when the most recent step sent from the same account", () => {
    const step1 = priorSend({ step_number: 1, connected_account_id: "account-1", gmail_thread_id: "thread-1" });
    const result = buildFollowUpContent({
      subject: "",
      body: "Second message",
      nextStep: 2,
      chain: [step1],
      currentAccountId: "account-1",
    });
    expect(result.threadId).toBe("thread-1");
  });

  it("does not reuse the Gmail thread id when this step sends from a different account", () => {
    const step1 = priorSend({ step_number: 1, connected_account_id: "account-1", gmail_thread_id: "thread-1" });
    const result = buildFollowUpContent({
      subject: "",
      body: "Second message",
      nextStep: 2,
      chain: [step1],
      currentAccountId: "account-2",
    });
    expect(result.threadId).toBeUndefined();
  });

  it("handles connected_account coming back as a single-element array", () => {
    const step1 = priorSend({
      connected_account: [{ email_address: "j@jaymestoneagency.com", display_name: "Jayme Stone" }],
    });
    const result = buildFollowUpContent({
      subject: "",
      body: "Second message",
      nextStep: 2,
      chain: [step1],
      currentAccountId: "account-1",
    });
    expect(result.finalBody).toContain("Jayme Stone <j@jaymestoneagency.com> wrote:");
  });

  it("falls back to just the email address when the account has no display name", () => {
    const step1 = priorSend({ connected_account: { email_address: "j@jaymestoneagency.com", display_name: null } });
    const result = buildFollowUpContent({
      subject: "",
      body: "Second message",
      nextStep: 2,
      chain: [step1],
      currentAccountId: "account-1",
    });
    expect(result.finalBody).toContain("j@jaymestoneagency.com wrote:");
  });

  it("does nothing extra on a follow-up step when no step 1 row is in the chain", () => {
    // e.g. the multi-row maybeSingle() bug this was written to guard against
    const step2 = priorSend({ step_number: 2 });
    const result = buildFollowUpContent({
      subject: "",
      body: "Second message",
      nextStep: 3,
      chain: [step2],
      currentAccountId: "account-1",
    });
    expect(result.finalSubject).toBe("");
    expect(result.finalBody).toBe("Second message");
    expect(result.htmlInner).toBe("Second message");
  });
});
