import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReplacementResearchTick } from "./replacementTick";

const findReplacementContact = vi.fn();
vi.mock("./findReplacement", () => ({ findReplacementContact: (...args: unknown[]) => findReplacementContact(...args) }));

const ITEM = {
  id: "rq-1",
  venue: "The Venue",
  venue_type: "Theater",
  city: "Austin",
  state: "TX",
  country: "United States",
  list_id: "list-1",
  removed_contact_email: "old@venue.example",
  removed_reason: "bounce",
  campaign_ids: [],
  research_attempts: 0,
};

/** Captures every replacement_queue update (in call order) plus whatever
 * other table reads processOneMessage-adjacent code needs, resolving with
 * sensible empty defaults everywhere else. */
function fakeSupabase(
  item: typeof ITEM,
  updates: Record<string, unknown>[],
  opts: { dailyCount?: { date: string; count: number } | null; capWrites?: Record<string, unknown>[] } = {},
): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === "app_settings") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.dailyCount ? { value: opts.dailyCount } : null, error: null }) }) }),
          upsert: async (row: Record<string, unknown>) => {
            opts.capWrites?.push(row);
            return { data: null, error: null };
          },
        };
      }
      if (table === "replacement_queue") {
        return {
          select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [item], error: null }) }) }) }),
          update: (fields: Record<string, unknown>) => ({
            eq: async () => {
              updates.push(fields);
              return { data: null, error: null };
            },
          }),
        };
      }
      // contacts / suppression / campaigns lookups used on the success path
      // -- not exercised by these error-path tests, but must resolve
      // cleanly rather than throw if reached.
      return {
        select: () => ({
          ilike: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          in: async () => ({ data: [], error: null }),
        }),
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("runReplacementResearchTick", () => {
  // The actual fix for a real risk: a research lookup that runs long
  // enough to hit the external platform's hard kill terminates the whole
  // request before any of our own code -- including a catch block -- runs.
  // With BATCH_SIZE=1 always re-fetching the same oldest pending row, the
  // old catch-only increment would leave that row's attempt count
  // unchanged forever, permanently blocking the entire queue behind it
  // with no self-healing. This proves the attempt is now recorded before
  // the risky call, not only after a (catchable) failure.
  it("records the attempt before calling findReplacementContact, not only in a catch block", async () => {
    const updates: Record<string, unknown>[] = [];
    const callOrder: string[] = [];
    findReplacementContact.mockReset().mockImplementationOnce(async () => {
      callOrder.push("findReplacementContact");
      return { found: false, note: "nothing found" };
    });

    const supabase = fakeSupabase(ITEM, updates);
    const originalPush = updates.push.bind(updates);
    updates.push = (item: Record<string, unknown>) => {
      if ("research_attempts" in item && Object.keys(item).length === 1) callOrder.push("pre-increment");
      return originalPush(item);
    };

    await runReplacementResearchTick(supabase);

    expect(callOrder[0]).toBe("pre-increment");
    expect(callOrder).toContain("findReplacementContact");
    expect(updates[0]).toEqual({ research_attempts: 1 });
  });

  it("does not double-increment research_attempts when the lookup throws", async () => {
    const updates: Record<string, unknown>[] = [];
    findReplacementContact.mockReset().mockRejectedValueOnce(new Error("boom"));

    const supabase = fakeSupabase(ITEM, updates);
    const result = await runReplacementResearchTick(supabase);

    expect(result.errors).toEqual([{ id: "rq-1", error: "boom" }]);
    // Pre-increment (1) + the catch-block's own update, which must reuse
    // that same value, not add a second increment on top of it.
    const attemptsWritten = updates.map((u) => u.research_attempts).filter((v) => v !== undefined);
    expect(attemptsWritten).toEqual([1, 1]);
  });

  it("gives up after MAX_RESEARCH_ATTEMPTS consecutive failures, marking it for a manual look", async () => {
    const updates: Record<string, unknown>[] = [];
    findReplacementContact.mockReset().mockRejectedValueOnce(new Error("still broken"));

    const supabase = fakeSupabase({ ...ITEM, research_attempts: 2 }, updates);
    await runReplacementResearchTick(supabase);

    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.status).toBe("no_replacement_found");
    expect(finalUpdate.research_attempts).toBe(3);
  });

  // Every lookup is a Claude call with live web search, and search results
  // are re-fed through the pause_turn loop as input tokens -- by far the
  // most expensive thing Mailflow does. Moving this job to every 15
  // minutes on 2026-09-18 took usage from ~200k to ~2.5M tokens/day. The
  // cron schedule lives outside this codebase, so the ceiling has to be
  // enforced here where it can't be changed by accident.
  const today = new Date().toISOString().slice(0, 10);

  it("does no research once the day's cap is spent", async () => {
    const updates: Record<string, unknown>[] = [];
    findReplacementContact.mockReset();

    const supabase = fakeSupabase(ITEM, updates, { dailyCount: { date: today, count: 50 } });
    const result = await runReplacementResearchTick(supabase);

    expect(result.cappedOut).toBe(true);
    expect(result.processed).toBe(0);
    expect(findReplacementContact).not.toHaveBeenCalled(); // no API call, no spend
    expect(updates).toEqual([]);
  });

  it("starts fresh when the stored count is from a previous day", async () => {
    const updates: Record<string, unknown>[] = [];
    findReplacementContact.mockReset().mockResolvedValueOnce({ found: false, note: "nothing" });

    const supabase = fakeSupabase(ITEM, updates, { dailyCount: { date: "2020-01-01", count: 999 } });
    const result = await runReplacementResearchTick(supabase);

    expect(result.cappedOut).toBe(false);
    expect(result.processed).toBe(1);
  });

  it("counts a lookup that throws, since the call was still paid for", async () => {
    const updates: Record<string, unknown>[] = [];
    const capWrites: Record<string, unknown>[] = [];
    findReplacementContact.mockReset().mockRejectedValueOnce(new Error("Request timed out."));

    const supabase = fakeSupabase(ITEM, updates, { dailyCount: { date: today, count: 7 }, capWrites });
    const result = await runReplacementResearchTick(supabase);

    expect(result.usedToday).toBe(8);
    expect(capWrites[0]).toEqual({ key: "research_daily_count", value: { date: today, count: 8 } });
  });

  it("treats a missing counter row as zero used, not as no cap", async () => {
    const updates: Record<string, unknown>[] = [];
    const capWrites: Record<string, unknown>[] = [];
    findReplacementContact.mockReset().mockResolvedValueOnce({ found: false, note: "nothing" });

    const supabase = fakeSupabase(ITEM, updates, { dailyCount: null, capWrites });
    const result = await runReplacementResearchTick(supabase);

    expect(result.cappedOut).toBe(false);
    // And it writes the row, so the cap is enforceable from here on.
    expect(capWrites[0]).toEqual({ key: "research_daily_count", value: { date: today, count: 1 } });
  });
});
