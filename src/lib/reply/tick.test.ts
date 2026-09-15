import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReplyPollTick } from "./tick";

// Every Gmail-facing and classification dependency is mocked so this
// exercises only runReplyPollTick's own control flow (reset-recovery
// wiring, spam-label handling, checkpoint advancement) -- not the real
// Gmail API or the classifier.
vi.mock("@/lib/gmail/client", () => ({ getAccessToken: vi.fn(async () => "fake-token") }));
vi.mock("@/lib/oauth/google", () => ({ OAuthTokenRevokedError: class OAuthTokenRevokedError extends Error {} }));
vi.mock("./bounceDetection", () => ({ classifyBounce: vi.fn(() => ({ isBounce: false, isHard: false })) }));
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

  it("runs a search-based recovery pass when the history checkpoint resets, and reports it in the result", async () => {
    fetchGmailMessage.mockResolvedValue(fakeEmail({ labelIds: ["INBOX"] }));
    listNewMessageIds.mockResolvedValueOnce({ messageIds: [], newHistoryId: "500", wasReset: true });
    searchMessageIds.mockResolvedValueOnce(["recovered-1"]);

    const supabaseAccounts = {
      from: (table: string) => {
        if (table === "connected_accounts") {
          return {
            select: () => ({ eq: () => ({ data: [{ id: "acc-1", email_address: "stone@jaymestone.com", last_history_id: "50" }], error: null }) }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        return fakeSupabase().from(table);
      },
    } as unknown as SupabaseClient;

    const result = await runReplyPollTick(supabaseAccounts);

    expect(searchMessageIds).toHaveBeenCalledWith("fake-token", "newer_than:2d");
    expect(result.historyResets).toEqual([{ account: "stone@jaymestone.com", recovered: 1 }]);
  });
});
