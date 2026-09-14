import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSendTick } from "./tick";

/** A `.from()` chain that ignores every filter method (the real query
 * builder's `.eq()`/`.in()`/`.lt()`/`.order()` don't affect what this test
 * returns — each test only ever has one row of DB state per table) and
 * resolves to `{ data, error: null }` both when awaited directly (the
 * pattern this codebase uses for a plain list query) and via `.single()`. */
class MockBuilder implements PromiseLike<{ data: unknown; error: null }> {
  constructor(private data: unknown) {}
  select() {
    return this;
  }
  eq() {
    return this;
  }
  in() {
    return this;
  }
  lt() {
    return this;
  }
  order() {
    return this;
  }
  single() {
    return Promise.resolve({ data: this.data, error: null });
  }
  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.data, error: null }).then(onfulfilled, onrejected);
  }
}

function mockSupabase(tables: Record<string, unknown>, rpcs: Record<string, unknown>): SupabaseClient {
  return {
    from: (table: string) => new MockBuilder(tables[table]),
    rpc: async (name: string) => ({ data: rpcs[name], error: null }),
  } as unknown as SupabaseClient;
}

const RAMP = [{ after_days: 0, cap: 40 }];

function account(id: string) {
  return { id, email_address: `${id}@example.com`, display_name: null, ramp_schedule: RAMP, ramp_started_at: "2020-01-01" };
}

function dueMember(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    campaign_member_id: "cm-1",
    campaign_id: "camp-1",
    contact_id: "contact-1",
    current_step: 1,
    next_step: 2,
    email: "venue@example.com",
    first_name: "Jane",
    last_name: "Doe",
    venue: "The Venue",
    city: "Austin",
    state: "TX",
    venue_type: "Theater",
    recipient_domain: "example.com",
    subject: "",
    body: "Following up",
    ...overrides,
  };
}

// Every test uses dryRun so it exercises the real account-selection logic
// (including the new pinning behavior) without reaching sendGmailMessage —
// no live network calls or DB writes.
describe("runSendTick account selection", () => {
  it("pins a follow-up step to whoever sent the most recent prior step, not round robin", async () => {
    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [account("acc-a"), account("acc-b")],
        send_counters: [],
        outbound_sends: [{ step_number: 1, connected_account_id: "acc-a" }],
      },
      { send_engine_who_is_due: [dueMember()] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    // Round robin starting from cursor -1 would pick "acc-a" first anyway,
    // so this alone wouldn't prove pinning — the real assertion is in the
    // next test, where pinning and round robin disagree.
    expect(result.details[0].account).toBe("acc-a@example.com");
  });

  it("does not switch accounts even when round robin would pick a different one next", async () => {
    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: 0 }], // cursor at "acc-a" → round robin would pick "acc-b" next
        connected_accounts: [account("acc-a"), account("acc-b")],
        send_counters: [],
        outbound_sends: [{ step_number: 1, connected_account_id: "acc-a" }],
      },
      { send_engine_who_is_due: [dueMember()] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.details[0].account).toBe("acc-a@example.com");
  });

  it("skips a follow-up step when its pinned account is no longer active, rather than switching", async () => {
    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [account("acc-b")], // "acc-a" (the pinned account) is gone from the active list
        send_counters: [],
        outbound_sends: [{ step_number: 1, connected_account_id: "acc-a" }],
      },
      { send_engine_who_is_due: [dueMember()] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(0);
    expect(result.skippedNoCapacity).toBe(1);
    expect(result.details[0].outcome).toContain("no longer active");
  });

  it("skips (rather than switches accounts) when the pinned account is at its daily cap", async () => {
    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [account("acc-a"), account("acc-b")],
        send_counters: [{ connected_account_id: "acc-a", sent_count: 40 }], // == cap
        outbound_sends: [{ step_number: 1, connected_account_id: "acc-a" }],
      },
      { send_engine_who_is_due: [dueMember()] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(0);
    expect(result.skippedNoCapacity).toBe(1);
    expect(result.details[0].outcome).toContain("daily cap");
  });

  it("still round robins a member's very first step, which has no prior sends to pin to", async () => {
    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [account("acc-a"), account("acc-b")],
        send_counters: [],
        outbound_sends: [],
      },
      { send_engine_who_is_due: [dueMember({ current_step: 0, next_step: 1 })] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.details[0].account).toBe("acc-a@example.com");
  });
});

const HIGH_RAMP = [{ after_days: 0, cap: 1000 }]; // high enough that account daily caps never gate these tests

describe("runSendTick candidate pool vs. per-tick domain cap", () => {
  it("looks past a domain-clustered front of the queue to find a distinct-domain send", async () => {
    // 55 due members all sharing one domain (only the first can send this
    // tick -- the rest hit the domain cap), then one due member on a
    // different domain. With DEFAULT_BATCH_LIMIT (50) as both the fetch
    // size and the send cap, that 56th member would never even be
    // fetched. It should still get a real send once the candidate pool is
    // large enough to reach it.
    const clustered = Array.from({ length: 55 }, (_, i) =>
      dueMember({
        campaign_member_id: `cm-gmail-${i}`,
        contact_id: `contact-gmail-${i}`,
        current_step: 0,
        next_step: 1,
        email: `venue${i}@gmail.com`,
        recipient_domain: "gmail.com",
      }),
    );
    const distinctDomain = dueMember({
      campaign_member_id: "cm-other",
      contact_id: "contact-other",
      current_step: 0,
      next_step: 1,
      email: "venue@a-totally-different-domain.org",
      recipient_domain: "a-totally-different-domain.org",
    });

    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [{ ...account("acc-a"), ramp_schedule: HIGH_RAMP }],
        send_counters: [],
        outbound_sends: [],
      },
      { send_engine_who_is_due: [...clustered, distinctDomain] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(2); // the one gmail.com send + the distinct-domain one
    expect(result.skippedDomainCap).toBe(54);
    expect(result.details.some((d) => d.email === "venue@a-totally-different-domain.org" && d.outcome === "would send")).toBe(true);
  });

  it("still stops at DEFAULT_BATCH_LIMIT real sends even with a much larger candidate pool available", async () => {
    const manyDistinctDomains = Array.from({ length: 60 }, (_, i) =>
      dueMember({
        campaign_member_id: `cm-${i}`,
        contact_id: `contact-${i}`,
        current_step: 0,
        next_step: 1,
        email: `venue${i}@domain${i}.example`,
        recipient_domain: `domain${i}.example`,
      }),
    );

    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [{ ...account("acc-a"), ramp_schedule: HIGH_RAMP }],
        send_counters: [],
        outbound_sends: [],
      },
      { send_engine_who_is_due: manyDistinctDomains },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(50);
  });
});
