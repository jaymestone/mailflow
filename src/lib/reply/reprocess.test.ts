import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reprocessStuckMessages } from "./reprocess";

vi.mock("@/lib/gmail/client", () => ({ getAccessToken: vi.fn(async () => "fake-token") }));

const fetchGmailMessage = vi.fn();
vi.mock("@/lib/gmail/messages", () => ({ fetchGmailMessage: (...args: unknown[]) => fetchGmailMessage(...args) }));

const classifyBounce = vi.fn((_email: unknown) => ({ isBounce: false, isHard: false }));
vi.mock("./bounceDetection", () => ({ classifyBounce: (email: unknown) => classifyBounce(email) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock forwards whatever args the real call sites pass
const processOneMessage = vi.fn(async (..._args: any[]) => "processed");
vi.mock("./tick", () => ({ processOneMessage: (...args: unknown[]) => processOneMessage(...args) }));

function fakeEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return { gmailMessageId: "msg-1", gmailThreadId: "thread-1", fromEmail: "a@b.com", fromName: "A", subject: "s", bodyText: "b", receivedAt: new Date().toISOString(), labelIds: [], inReplyTo: null, references: [], ...overrides };
}

const ACCOUNT = { id: "acc-1", email_address: "stone@jaymestone.com" };

function fakeSupabase(): SupabaseClient {
  return {
    from: () => ({
      select: () => ({ eq: async () => ({ data: [ACCOUNT], error: null }) }),
    }),
  } as unknown as SupabaseClient;
}

/** Queues Gmail message-search responses (one per account, in call order)
 * for the raw fetch() the discovery loop issues directly. */
function mockGmailSearch(...idBatches: string[][]) {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const ids = idBatches[Math.min(call++, idBatches.length - 1)] ?? [];
      return { json: async () => ({ messages: ids.map((id) => ({ id })) }) } as Response;
    }),
  );
}

describe("reprocessStuckMessages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchGmailMessage.mockReset();
    classifyBounce.mockReset().mockReturnValue({ isBounce: false, isHard: false });
    processOneMessage.mockClear();
  });

  it("dry run: discovers and buckets candidates without calling processOneMessage", async () => {
    mockGmailSearch(["m1", "m2"]);
    fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ gmailMessageId: "m1" })).mockResolvedValueOnce(fakeEmail({ gmailMessageId: "m2" }));
    classifyBounce.mockReturnValueOnce({ isBounce: true, isHard: true }).mockReturnValueOnce({ isBounce: false, isHard: false });

    const result = await reprocessStuckMessages(fakeSupabase(), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.bounceCandidateCount).toBe(1);
    expect(result.replyCandidateCount).toBe(1);
    expect(processOneMessage).not.toHaveBeenCalled();
  });

  it("skips the sender's own SENT copy -- neither bucket, never processed", async () => {
    mockGmailSearch(["m1"]);
    fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ gmailMessageId: "m1", labelIds: ["SENT"] }));

    const result = await reprocessStuckMessages(fakeSupabase(), { dryRun: true });

    expect(result.bounceCandidateCount).toBe(0);
    expect(result.replyCandidateCount).toBe(0);
  });

  it("live run: processes bounces before replies, and reports what processOneMessage did", async () => {
    mockGmailSearch(["b1", "r1"]);
    fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ gmailMessageId: "b1" })).mockResolvedValueOnce(fakeEmail({ gmailMessageId: "r1" }));
    classifyBounce.mockReturnValueOnce({ isBounce: true, isHard: true }).mockReturnValueOnce({ isBounce: false, isHard: false });

    const callOrder: string[] = [];
    processOneMessage.mockImplementation(async (_s, _a, messageId: string, _t, _c, result: { bounces: number; replies: number }) => {
      callOrder.push(messageId);
      if (messageId === "b1") result.bounces++;
      else result.replies++;
      return "processed";
    });

    const result = await reprocessStuckMessages(fakeSupabase(), { dryRun: false });

    expect(callOrder).toEqual(["b1", "r1"]);
    expect(result.bounceResult.bounces).toBe(1);
    expect(result.replyResult.replies).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("clamps windowDays into the Gmail search query instead of passing an unbounded value through", async () => {
    let capturedUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        capturedUrl = String(url);
        return { json: async () => ({ messages: [] }) } as Response;
      }),
    );

    await reprocessStuckMessages(fakeSupabase(), { dryRun: true, windowDays: 999 });

    expect(capturedUrl).toContain("newer_than%3A14d"); // MAX_WINDOW_DAYS
  });

  it("caps a real run at maxMessages, prioritizing bounces, and reports truncated", async () => {
    mockGmailSearch(["b1", "b2", "r1"]);
    fetchGmailMessage
      .mockResolvedValueOnce(fakeEmail({ gmailMessageId: "b1" }))
      .mockResolvedValueOnce(fakeEmail({ gmailMessageId: "b2" }))
      .mockResolvedValueOnce(fakeEmail({ gmailMessageId: "r1" }));
    classifyBounce
      .mockReturnValueOnce({ isBounce: true, isHard: true })
      .mockReturnValueOnce({ isBounce: true, isHard: true })
      .mockReturnValueOnce({ isBounce: false, isHard: false });

    const processed: string[] = [];
    processOneMessage.mockImplementation(async (_s, _a, messageId: string) => {
      processed.push(messageId);
      return "processed";
    });

    const result = await reprocessStuckMessages(fakeSupabase(), { dryRun: false, maxMessages: 1 });

    expect(result.bounceCandidateCount).toBe(2);
    expect(result.replyCandidateCount).toBe(1);
    expect(result.truncated).toBe(true);
    // Only 1 slot total, spent on a bounce -- the reply never runs this call.
    expect(processed).toEqual(["b1"]);
  });
});
