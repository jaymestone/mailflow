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
function fakeSupabase(item: typeof ITEM, updates: Record<string, unknown>[]): SupabaseClient {
  return {
    from: (table: string) => {
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
});
