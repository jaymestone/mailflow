import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backoffMinutes, isBlocked, isStale, needsSummary, runConversationSummarizeTick } from "./summarizeTick";

const summarizeThread = vi.hoisted(() => vi.fn());
vi.mock("./summarize", () => ({ summarizeThread }));

const SUMMARY = {
  gist: "Two sets at the Barn, 12 Aug, $3,500 accepted.",
  next_action: "Send contract",
  fee_amount: 3500,
  fee_note: null,
  artist: "Jayme Stone",
  venue: "The Barn",
  is_agreed: true,
  is_small: false,
};

const NOW = new Date("2026-10-02T12:00:00Z");

/** The guard is the whole point of this file, so it is tested directly as
 * well as through the tick -- a regression here is invisible until an
 * invoice arrives. */
describe("isStale", () => {
  const base = {
    summarized_at: "2026-10-02T01:00:00Z",
    last_message_at: "2026-09-30T10:00:00Z",
    summary_source_hash: "abc",
    summarized_source_hash: "abc",
  };

  it("skips a thread whose message set has not changed", () => {
    expect(isStale(base)).toBe(false);
  });

  it("summarises a thread that has never been summarised", () => {
    expect(isStale({ ...base, summarized_at: null })).toBe(true);
  });

  it("summarises when the message set has changed", () => {
    expect(isStale({ ...base, summary_source_hash: "def" })).toBe(true);
  });

  it("summarises when the gist predates the hash column", () => {
    expect(isStale({ ...base, summarized_source_hash: null })).toBe(true);
  });

  // This is the case that was costing money: a timestamp moving on its own
  // used to be enough to re-summarise the entire live board, because the
  // guard asked about times rather than about contents.
  it("does NOT re-summarise when only last_message_at moved past the gist", () => {
    expect(isStale({ ...base, last_message_at: "2026-10-02T23:00:00Z" })).toBe(false);
  });

  it("falls back to timestamps when no hash is available at all", () => {
    const noHash = { ...base, summary_source_hash: null, summarized_source_hash: null };
    expect(isStale({ ...noHash, last_message_at: "2026-10-02T23:00:00Z" })).toBe(true);
    expect(isStale(noHash)).toBe(false);
  });
});

describe("isBlocked / backoffMinutes", () => {
  it("holds a thread back until its wait elapses", () => {
    expect(isBlocked({ summarize_blocked_until: "2026-10-02T12:00:01Z" }, NOW)).toBe(true);
    expect(isBlocked({ summarize_blocked_until: "2026-10-02T11:59:59Z" }, NOW)).toBe(false);
    expect(isBlocked({ summarize_blocked_until: null }, NOW)).toBe(false);
  });

  it("widens the wait and then caps it at a day", () => {
    expect([1, 2, 3, 4].map(backoffMinutes)).toEqual([15, 60, 240, 1440]);
    expect(backoffMinutes(9)).toBe(1440);
  });

  it("combines both tests: changed but blocked means skip", () => {
    const row = {
      summarized_at: "2026-10-01T00:00:00Z",
      last_message_at: "2026-10-01T00:00:00Z",
      summary_source_hash: "def",
      summarized_source_hash: "abc",
      summarize_blocked_until: "2026-10-02T13:00:00Z",
    };
    expect(isStale(row)).toBe(true);
    expect(needsSummary(row, NOW)).toBe(false);
    expect(needsSummary({ ...row, summarize_blocked_until: null }, NOW)).toBe(true);
  });
});

type Row = Record<string, unknown>;

/** Enough of the PostgREST builder to drive one summarize tick, capturing
 * the per-id updates so the test can assert what was written. */
function fakeSupabase(conversations: Row[], messages: Row[]) {
  const updates: { id: unknown; payload: Row }[] = [];
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: conversations, error: null }),
        in: () => Promise.resolve({ data: table === "inbound_messages" ? messages : [], error: null }),
        update(payload: Row) {
          return {
            eq: (_col: string, id: unknown) => {
              updates.push({ id, payload });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

const MESSAGES = [
  {
    subject: "The Barn",
    body_text: "We can do $3,500 for two sets.",
    from_email: "barn@example.com",
    received_at: "2026-09-30T10:00:00Z",
  },
];

describe("runConversationSummarizeTick", () => {
  beforeEach(() => {
    summarizeThread.mockReset();
    summarizeThread.mockResolvedValue(SUMMARY);
  });

  const row = (over: Row = {}) => ({
    id: "c1",
    thread_key: "barn",
    gmail_thread_ids: ["t1"],
    summary_source_hash: "abc",
    summarized_source_hash: "abc",
    summarized_at: "2026-10-02T01:00:00Z",
    status_override: null,
    last_message_at: "2026-09-30T10:00:00Z",
    last_direction: "inbound",
    summarize_attempts: 0,
    summarize_blocked_until: null,
    ...over,
  });

  it("spends nothing when every thread is already current", async () => {
    const { client, updates } = fakeSupabase([row(), row({ id: "c2" })], MESSAGES);
    const result = await runConversationSummarizeTick(client, { now: NOW });

    expect(summarizeThread).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.candidates).toBe(0);
    expect(result.summarized).toBe(0);
  });

  it("summarises a changed thread, records the hash it read, and clears failures", async () => {
    const { client, updates } = fakeSupabase(
      [row({ summary_source_hash: "def", summarize_attempts: 2 })],
      MESSAGES,
    );
    const result = await runConversationSummarizeTick(client, { now: NOW });

    expect(summarizeThread).toHaveBeenCalledTimes(1);
    expect(result.summarized).toBe(1);
    expect(updates[0].payload.summarized_source_hash).toBe("def");
    expect(updates[0].payload.gist).toBe(SUMMARY.gist);
    expect(updates[0].payload.summarize_attempts).toBe(0);
    expect(updates[0].payload.summarize_blocked_until).toBeNull();
  });

  // Without this, the next tick would see summarized_source_hash matching
  // and treat a thread that never got a gist as current.
  it("records a backoff on failure and leaves the stored hash alone", async () => {
    summarizeThread.mockRejectedValue(new Error("timeout"));
    const { client, updates } = fakeSupabase([row({ summary_source_hash: "def" })], MESSAGES);
    const result = await runConversationSummarizeTick(client, { now: NOW });

    expect(result.failed).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({
      summarize_attempts: 1,
      summarize_blocked_until: "2026-10-02T12:15:00.000Z",
    });
    expect(updates[0].payload.summarized_source_hash).toBeUndefined();
    expect(result.errors[0]).toContain("retry in 15m");
  });

  it("widens the wait for a thread that has already failed three times", async () => {
    summarizeThread.mockRejectedValue(new Error("timeout"));
    const { client, updates } = fakeSupabase(
      [row({ summary_source_hash: "def", summarize_attempts: 3 })],
      MESSAGES,
    );
    await runConversationSummarizeTick(client, { now: NOW });

    expect(updates[0].payload.summarize_attempts).toBe(4);
    expect(updates[0].payload.summarize_blocked_until).toBe("2026-10-03T12:00:00.000Z");
  });

  // The leak this closes: three failing threads at the top of the order
  // used to consume the whole per-tick budget on every tick, forever.
  it("does not spend on a thread that is serving a backoff", async () => {
    const { client, updates } = fakeSupabase(
      [
        row({ id: "c1", summary_source_hash: "def", summarize_blocked_until: "2026-10-02T13:00:00Z" }),
        row({ id: "c2", summary_source_hash: "def", summarize_blocked_until: "2026-10-02T13:00:00Z" }),
      ],
      MESSAGES,
    );
    const result = await runConversationSummarizeTick(client, { now: NOW });

    expect(summarizeThread).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.candidates).toBe(0);
    expect(result.blocked).toBe(2);
  });

  it("reaches a healthy thread that sits behind blocked ones", async () => {
    const { client } = fakeSupabase(
      [
        row({ id: "c1", summary_source_hash: "def", summarize_blocked_until: "2026-10-02T13:00:00Z" }),
        row({ id: "c2", summary_source_hash: "ghi" }),
      ],
      MESSAGES,
    );
    const result = await runConversationSummarizeTick(client, { now: NOW });

    expect(result.blocked).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.summarized).toBe(1);
  });

  it("stops on the deadline rather than being cut off mid-write", async () => {
    const { client, updates } = fakeSupabase(
      [row({ id: "c1", summary_source_hash: "x1" }), row({ id: "c2", summary_source_hash: "x2" })],
      MESSAGES,
    );
    // startedAt far enough in the past that the deadline has already passed.
    const result = await runConversationSummarizeTick(client, { now: NOW, startedAt: Date.now() - 60_000 });

    expect(result.stoppedOnDeadline).toBe(true);
    expect(updates).toHaveLength(0);
    expect(summarizeThread).not.toHaveBeenCalled();
  });
});
