import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncConversationsToNotion } from "./sync";

// The deadline is checked before each row is touched, so a budget that has
// already elapsed means the loop exits without ever reaching the network.
// That is what makes this testable without standing up a Notion mock -- and
// it is also the property that matters: stopping short is the whole point.
const fetchSpy = vi.spyOn(globalThis, "fetch");

function fakeSupabase(rows: Record<string, unknown>[]) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

/** One conversation Notion has not seen at this revision. */
const pendingRow = (id: string) => ({
  id,
  thread_key: `t-${id}`,
  venue: "The Barn",
  artist: "Jayme Stone",
  region: "Northeast",
  status: "needs_reply",
  fee_amount: 3500,
  gist: "Two sets, 12 Aug.",
  next_action: "Send contract",
  last_message_at: "2026-10-02T10:00:00Z",
  last_direction: "inbound",
  is_live: true,
  revision: 2,
  notion_page_id: `page-${id}`,
  notion_synced_revision: 1,
});

describe("syncConversationsToNotion", () => {
  it("stops before touching Notion when the budget is already spent", async () => {
    fetchSpy.mockClear();
    const supabase = fakeSupabase([pendingRow("a"), pendingRow("b")]);

    const result = await syncConversationsToNotion(supabase, {
      databaseId: "db-1",
      token: "tok",
      startedAt: Date.now() - 60_000,
    });

    expect(result.stoppedOnDeadline).toBe(true);
    expect(result.created + result.updated + result.archived).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Still reports the true size of the backlog, which is what makes a
    // stuck sync visible in cron_health rather than looking idle.
    expect(result.pending).toBe(2);
  });

  // The regression this guards: the default was 40s behind a trigger that
  // disconnects at 30, so every run was killed mid-write and the backlog
  // never cleared. The default must stay inside that ceiling.
  it("defaults to a budget that fits inside the 30s trigger ceiling", async () => {
    fetchSpy.mockClear();
    const supabase = fakeSupabase([pendingRow("a")]);

    const result = await syncConversationsToNotion(supabase, {
      databaseId: "db-1",
      token: "tok",
      // 25s in: past any safe default, still short of the 30s disconnect.
      startedAt: Date.now() - 25_000,
    });

    expect(result.stoppedOnDeadline).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an empty backlog when everything is already in sync", async () => {
    fetchSpy.mockClear();
    const supabase = fakeSupabase([{ ...pendingRow("a"), notion_synced_revision: 2 }]);

    const result = await syncConversationsToNotion(supabase, {
      databaseId: "db-1",
      token: "tok",
      startedAt: Date.now(),
    });

    expect(result.pending).toBe(0);
    expect(result.stoppedOnDeadline).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
