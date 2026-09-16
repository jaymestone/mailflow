import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReplyPollTick } from "./tick";

// Every Gmail-facing and classification dependency is mocked so this
// exercises only runReplyPollTick's own control flow (reset-recovery
// wiring, spam-label handling, checkpoint advancement) -- not the real
// Gmail API or the classifier.
vi.mock("@/lib/gmail/client", () => ({ getAccessToken: vi.fn(async () => "fake-token") }));
vi.mock("@/lib/oauth/google", () => ({ OAuthTokenRevokedError: class OAuthTokenRevokedError extends Error {} }));
const classifyBounce = vi.fn((_email: unknown) => ({ isBounce: false, isHard: false }));
vi.mock("./bounceDetection", () => ({ classifyBounce: (email: unknown) => classifyBounce(email) }));
vi.mock("./classify", () => ({
  classifyReply: vi.fn(async () => ({ category: "interested", oooReturnDate: null })),
}));
vi.mock("./matching", () => ({
  matchInboundMessage: vi.fn(async () => ({ campaignId: null, contactId: null, outboundSendId: null, matchMethod: "unmatched" })),
}));
vi.mock("@/lib/gmail/labels", () => ({
  CATEGORY_LABEL_NAMES: { interested: "Interested" },
  getOrCreateLabelId: vi.fn(async () => "label-123"),
  applyGmailLabel: vi.fn(async () => undefined),
}));

const fetchGmailMessage = vi.fn();
vi.mock("@/lib/gmail/messages", () => ({ fetchGmailMessage: (...args: unknown[]) => fetchGmailMessage(...args) }));

const listNewMessageIds = vi.fn();
const searchMessageIds = vi.fn();
const getCurrentHistoryId = vi.fn(async () => "999");
vi.mock("@/lib/gmail/history", () => ({
  listNewMessageIds: (...args: unknown[]) => listNewMessageIds(...args),
  searchMessageIds: (...args: unknown[]) => searchMessageIds(...args),
  getCurrentHistoryId: () => getCurrentHistoryId(),
}));

function fakeEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    gmailMessageId: "msg-1",
    gmailThreadId: "thread-1",
    fromEmail: "zach@planningstages.net",
    fromName: "Zach Taylor",
    subject: "Re: New Roster",
    bodyText: "Interested!",
    receivedAt: "2026-09-14T19:28:16Z",
    labelIds: ["INBOX"],
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

/** Every `.from()` call resolves to `{ data: null, error: null }` for a
 * plain select/insert/update chain, and `null` for `.single()`/
 * `.maybeSingle()` -- none of these tests depend on real row data flowing
 * back through Supabase, only on what Gmail-side calls happen. */
function fakeSupabase(): SupabaseClient {
  const builder = {
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    delete: () => builder,
    eq: () => builder,
    ilike: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
  };
  return {
    from: () => builder,
  } as unknown as SupabaseClient;
}

describe("runReplyPollTick", () => {
  it("removes the SPAM label when present, alongside applying the category label", async () => {
    fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ labelIds: ["INBOX", "SPAM"] }));
    listNewMessageIds.mockResolvedValueOnce({ messageIds: ["msg-1"], newHistoryId: "100", wasReset: false });

    const { applyGmailLabel } = await import("@/lib/gmail/labels");

    // Only the accounts lookup needs real data; every other table just
    // needs a chain that resolves cleanly (this message is unmatched, so no
    // suppression/pause/replacement-queue paths trigger).
    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return { select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50" }], error: null }) }) };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    await runReplyPollTick(supabaseAccounts);

    expect(applyGmailLabel).toHaveBeenCalledWith("fake-token", "msg-1", "label-123", expect.arrayContaining(["SPAM"]));
  });

  // The search-based recovery pass was temporarily disabled 2026-09-15
  // after causing repeated live timeouts, then re-enabled 2026-09-16 once
  // the actual cause (an unrelated, since-fixed unbounded-pagination bug in
  // listNewMessageIds) was found -- searchMessageIds is already capped to
  // one page specifically so this can't repeat that timeout. A reset with
  // nothing found still re-baselines the checkpoint and is recorded with
  // recovered:0.
  it("searches for a recovery window on a reset checkpoint, reporting zero recovered when nothing is found", async () => {
    listNewMessageIds.mockResolvedValueOnce({ messageIds: [], newHistoryId: "500", wasReset: true });
    searchMessageIds.mockResolvedValueOnce([]);

    const updateEq = vi.fn(async () => ({ data: null, error: null }));
    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return {
            select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50" }], error: null }) }),
            update: () => ({ eq: updateEq }),
          };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    const result = await runReplyPollTick(supabaseAccounts);

    expect(searchMessageIds).toHaveBeenCalledWith("fake-token", "newer_than:3d");
    expect(result.historyResets).toEqual([{ account: "stone@jaymestone.com", recovered: 0 }]);
    expect(updateEq).toHaveBeenCalledWith("id", "acc-1"); // checkpoint still re-baselines to newHistoryId
  });

  it("actually recovers a message the search finds after a reset, running it through the real pipeline", async () => {
    listNewMessageIds.mockResolvedValueOnce({ messageIds: [], newHistoryId: "500", wasReset: true });
    searchMessageIds.mockResolvedValueOnce(["recovered-1"]);
    fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ gmailMessageId: "recovered-1", labelIds: ["INBOX"] }));

    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return { select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50" }], error: null }) }) };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    const result = await runReplyPollTick(supabaseAccounts);

    expect(result.historyResets).toEqual([{ account: "stone@jaymestone.com", recovered: 1 }]);
  });

  // The actual fix for what Jayme reported live on 2026-09-15: a message
  // already classified and recorded, but whose Gmail label never
  // successfully applied (e.g. hit a rate limit), used to be permanently
  // invisible to every future poll -- the existing-row check treated
  // "recorded" as "fully done" with no way to tell the two states apart.
  it("retries only the label step for an already-recorded message whose label never applied, without reclassifying", async () => {
    listNewMessageIds.mockResolvedValueOnce({ messageIds: ["msg-1"], newHistoryId: "100", wasReset: false });
    fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ labelIds: ["INBOX"] }));

    const { applyGmailLabel } = await import("@/lib/gmail/labels");
    const { classifyReply } = await import("./classify");
    vi.mocked(classifyReply).mockClear();
    vi.mocked(applyGmailLabel).mockClear();
    const updateEq = vi.fn(async () => ({ data: null, error: null }));

    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return { select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50" }], error: null }) }) };
        }
        if (table === "inbound_messages") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: "row-1", classification_category: "interested", label_applied_at: null },
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => ({ eq: updateEq }),
          };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    const result = await runReplyPollTick(supabaseAccounts);

    expect(classifyReply).not.toHaveBeenCalled();
    expect(applyGmailLabel).toHaveBeenCalledWith("fake-token", "msg-1", "label-123", undefined);
    expect(updateEq).toHaveBeenCalledWith("id", "row-1");
    expect(result.messagesFetched).toBe(0); // not counted as a newly-fetched message, it's a retry
  });

  // Confirmed live, 2026-09-15: without persisting where a truncated
  // traversal left off, a high-volume account's checkpoint froze for hours
  // -- every tick restarted from the same old point and never got far
  // enough to reach its own new mail. This pins down that a truncated
  // result stores the resume token (not the real checkpoint) and passes it
  // back in on the next call.
  it("persists the resume page token (not last_history_id) when pagination is truncated, and passes it to the next call", async () => {
    listNewMessageIds.mockResolvedValueOnce({
      messageIds: [],
      newHistoryId: "50", // unchanged -- see gmail/history.ts, truncated never reports an advanced checkpoint
      wasReset: false,
      truncated: true,
      nextPageToken: "page-2-token",
    });

    let capturedUpdate: Record<string, unknown> | undefined;
    const updateEq = vi.fn(async () => ({ data: null, error: null }));
    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return {
            select: () => ({
              eq: () => ({
                data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50", history_page_token: null }],
                error: null,
              }),
            }),
            update: (fields: Record<string, unknown>) => {
              capturedUpdate = fields;
              return { eq: updateEq };
            },
          };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    await runReplyPollTick(supabaseAccounts);

    expect(listNewMessageIds).toHaveBeenCalledWith("fake-token", "50", null);
    expect(capturedUpdate).toEqual({ history_page_token: "page-2-token" });
    expect(updateEq).toHaveBeenCalledWith("id", "acc-1");
  });

  // The actual fix for what Jayme reported live on 2026-09-15: a bounce-
  // heavy backlog held steady for 3+ hours because bounces and genuine
  // replies shared one small tick-wide cap, even though bounces need no
  // AI call and cost almost nothing. This proves cheap and expensive now
  // draw from separate budgets sized very differently.
  it("gives bounces a much larger tick-wide budget than genuine replies, which stay conservatively capped", async () => {
    const messageIds = ["b1", "b2", "b3", "b4", "b5", "r1", "r2", "r3"];
    listNewMessageIds.mockResolvedValueOnce({ messageIds, newHistoryId: "100", wasReset: false, truncated: false, nextPageToken: null });

    // First 5 calls (b1-b5) are bounces, last 3 (r1-r3) are genuine replies.
    classifyBounce.mockReset();
    for (let i = 0; i < 5; i++) classifyBounce.mockReturnValueOnce({ isBounce: true, isHard: true });
    for (let i = 0; i < 3; i++) classifyBounce.mockReturnValueOnce({ isBounce: false, isHard: false });

    for (const id of messageIds) {
      fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ gmailMessageId: id, labelIds: ["INBOX"] }));
    }

    const { classifyReply } = await import("./classify");
    vi.mocked(classifyReply).mockClear();

    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return { select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50", history_page_token: null }], error: null }) }) };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    const result = await runReplyPollTick(supabaseAccounts);

    // All 5 bounces fit inside the cheap budget (8) -- none throttled.
    expect(result.bounces).toBe(5);
    // Only 2 of the 3 replies fit inside the conservative expensive budget.
    expect(classifyReply).toHaveBeenCalledTimes(2);
  });

  // The actual bug behind what Jayme reported live on 2026-09-16: two
  // genuine replies vanished with no inbound_messages row at all -- traced
  // to the checkpoint only being held back when BOTH budgets were fully
  // drained, even though processOneMessage itself bails (with nothing
  // written) the moment its OWN bucket hits zero. A message needing the
  // cheap bucket after it's spent gets silently dropped mid-list while the
  // expensive bucket still has room, the old both-exhausted check never
  // trips, and the checkpoint advances past it as if the tick fully
  // succeeded -- permanently, since Gmail history never resurfaces an
  // already-passed message. This proves the checkpoint now stays put
  // whenever *either* bucket ran out mid-list, not just when both did.
  it("does not advance the checkpoint when the cheap budget runs out mid-list even though the expensive budget still has room", async () => {
    // 9 bounces -- cheap budget is 8, so the 9th needs a bucket that's
    // already spent. No genuine replies at all, so expensive budget (2)
    // never gets touched and stays available the whole time.
    const messageIds = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"];
    listNewMessageIds.mockResolvedValueOnce({ messageIds, newHistoryId: "999", wasReset: false, truncated: false, nextPageToken: null });

    classifyBounce.mockReset();
    for (const id of messageIds) {
      classifyBounce.mockReturnValueOnce({ isBounce: true, isHard: true });
      fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ gmailMessageId: id, labelIds: ["INBOX"] }));
    }

    let capturedUpdate: Record<string, unknown> | undefined;
    const updateEq = vi.fn(async () => ({ data: null, error: null }));
    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return {
            select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50", history_page_token: null }], error: null }) }),
            update: (fields: Record<string, unknown>) => {
              capturedUpdate = fields;
              return { eq: updateEq };
            },
          };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    const result = await runReplyPollTick(supabaseAccounts);

    // Only the first 8 bounces fit inside the cheap budget.
    expect(result.bounces).toBe(8);
    // The checkpoint must NOT have been advanced to the new historyId --
    // the 9th bounce was never actually looked at, so connected_accounts
    // is never updated at all this tick (neither the "full traversal
    // completed" branch nor the truncated-resume branch applies).
    expect(updateEq).not.toHaveBeenCalled();
    expect(capturedUpdate).toBeUndefined();
  });

  // Broader than the two specific incidents above: the actual invariant
  // that must hold regardless of message mix or budget size is "the
  // checkpoint only advances when every fetched message was actually
  // handled." The two regression tests above each pin down one instance of
  // this (all-bounce / cheap-only); this table exercises several different
  // mixes and budget sizes so a *different* future way of breaking the
  // same invariant (e.g. a third budget bucket added later, or the
  // exhaustion check moved somewhere that misses a case) is more likely to
  // get caught here too, not just re-break this one specific shape again.
  describe("checkpoint-advance invariant: advances iff no message was dropped for budget reasons", () => {
    // Built around the real, deployed budget constants (MAX_CHEAP_MESSAGES_PER_TICK=8,
    // MAX_EXPENSIVE_MESSAGES_PER_TICK=2 -- see the top of tick.ts) rather
    // than an injected budget, so this exercises the actual production
    // configuration, not just the mechanism in the abstract.
    const cases: { name: string; bounces: number; replies: number; expectAdvance: boolean }[] = [
      { name: "all bounces, cheap budget covers all of them", bounces: 4, replies: 0, expectAdvance: true },
      { name: "all bounces, cheap budget exactly matches (boundary)", bounces: 8, replies: 0, expectAdvance: true },
      { name: "all bounces, one more than cheap budget", bounces: 9, replies: 0, expectAdvance: false },
      { name: "all replies, expensive budget covers all of them", bounces: 0, replies: 2, expectAdvance: true },
      { name: "all replies, one more than expensive budget", bounces: 0, replies: 3, expectAdvance: false },
      { name: "mixed, both budgets sufficient", bounces: 5, replies: 2, expectAdvance: true },
      { name: "mixed, cheap insufficient but expensive has room to spare", bounces: 9, replies: 1, expectAdvance: false },
      { name: "mixed, expensive insufficient but cheap has room to spare", bounces: 1, replies: 3, expectAdvance: false },
    ];

    it.each(cases)("$name -> checkpoint advances: $expectAdvance", async ({ bounces, replies, expectAdvance }) => {
      const messageIds = [
        ...Array.from({ length: bounces }, (_, i) => `b${i}`),
        ...Array.from({ length: replies }, (_, i) => `r${i}`),
      ];
      listNewMessageIds.mockReset().mockResolvedValueOnce({ messageIds, newHistoryId: "999", wasReset: false, truncated: false, nextPageToken: null });

      classifyBounce.mockReset();
      for (let i = 0; i < bounces; i++) classifyBounce.mockReturnValueOnce({ isBounce: true, isHard: true });
      for (let i = 0; i < replies; i++) classifyBounce.mockReturnValueOnce({ isBounce: false, isHard: false });

      fetchGmailMessage.mockReset();
      for (const id of messageIds) fetchGmailMessage.mockResolvedValueOnce(fakeEmail({ gmailMessageId: id, labelIds: ["INBOX"] }));

      let advanced = false;
      const updateEq = vi.fn(async () => ({ data: null, error: null }));
      const supabaseAccounts = {
        from: (table: string) => {
          if (table === "connected_accounts") {
            return {
              select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50", history_page_token: null }], error: null }) }),
              update: (fields: Record<string, unknown>) => {
                if (fields.last_history_id === "999") advanced = true;
                return { eq: updateEq };
              },
            };
          }
          return fakeSupabase().from(table);
        },
      } as unknown as SupabaseClient;

      await runReplyPollTick(supabaseAccounts);

      expect(advanced).toBe(expectAdvance);
    });
  });
});
