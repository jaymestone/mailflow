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
  neq() {
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
    // 55 due members all sharing one ORGANISATION's domain (only the first
    // can send this tick -- the rest hit the domain cap), then one due
    // member on a different domain. If the fetch size were as small as the
    // real send cap (well under 55), that 56th member would never even be
    // fetched. It should still get a real send once the candidate pool is
    // large enough to reach it.
    //
    // Deliberately NOT gmail.com, though this cluster was gmail.com when
    // the test was written: consumer mailbox providers are now exempt from
    // the per-tick domain cap (see CONSUMER_MAILBOX_DOMAINS in tick.ts), so
    // using one here would no longer exercise the cap at all.
    const clustered = Array.from({ length: 55 }, (_, i) =>
      dueMember({
        campaign_member_id: `cm-clustered-${i}`,
        contact_id: `contact-clustered-${i}`,
        current_step: 0,
        next_step: 1,
        email: `staff${i}@one-big-university.edu`,
        recipient_domain: "one-big-university.edu",
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

    expect(result.sent).toBe(2); // the one university send + the distinct-domain one
    expect(result.skippedDomainCap).toBe(54);
    expect(result.details.some((d) => d.email === "venue@a-totally-different-domain.org" && d.outcome === "would send")).toBe(true);
  });

  // Regression: confirmed live 2026-09-23 that a queue of 149 due contacts,
  // every one of them a gmail.com address, sent exactly ONE mail per
  // 5-minute tick -- roughly 108 sends/day against 1,350 of configured
  // capacity. The domain cap is there to spare one organisation's mail
  // server a burst; it protects nothing when the "domain" is a consumer
  // mailbox provider shared by hundreds of unrelated individuals.
  it("does not apply the per-tick domain cap to consumer mailbox providers", async () => {
    const allGmail = Array.from({ length: 40 }, (_, i) =>
      dueMember({
        campaign_member_id: `cm-gmail-${i}`,
        contact_id: `contact-gmail-${i}`,
        current_step: 0,
        next_step: 1,
        email: `booker${i}@gmail.com`,
        recipient_domain: "gmail.com",
      }),
    );

    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [{ ...account("acc-a"), ramp_schedule: HIGH_RAMP }],
        send_counters: [],
        outbound_sends: [],
      },
      { send_engine_who_is_due: allGmail },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    // Bounded by the per-tick batch limit, not throttled down to 1.
    expect(result.sent).toBe(20);
    expect(result.skippedDomainCap).toBe(0);
  });

  it("still caps a single organisation's domain while letting consumer addresses through in the same tick", async () => {
    // The two rules have to coexist: one send to the university, and every
    // gmail.com recipient still free to go out alongside it.
    const university = Array.from({ length: 5 }, (_, i) =>
      dueMember({
        campaign_member_id: `cm-edu-${i}`,
        contact_id: `contact-edu-${i}`,
        current_step: 0,
        next_step: 1,
        email: `staff${i}@one-big-university.edu`,
        recipient_domain: "one-big-university.edu",
      }),
    );
    const consumer = ["gmail.com", "yahoo.com", "hotmail.com", "aol.com", "gmail.com"].map((domain, i) =>
      dueMember({
        campaign_member_id: `cm-consumer-${i}`,
        contact_id: `contact-consumer-${i}`,
        current_step: 0,
        next_step: 1,
        email: `booker${i}@${domain}`,
        recipient_domain: domain,
      }),
    );

    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [{ ...account("acc-a"), ramp_schedule: HIGH_RAMP }],
        send_counters: [],
        outbound_sends: [],
      },
      { send_engine_who_is_due: [...university, ...consumer] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    // 1 university + all 5 consumer addresses (including both gmail.com).
    expect(result.sent).toBe(6);
    expect(result.skippedDomainCap).toBe(4);
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

    expect(result.sent).toBe(20);
  });
});

// Confirmed live, 2026-09-16: a tick ran long enough to hit cron-job.org's
// external 30s kill while holding the send lock. That kill terminates the
// whole invocation, so the `finally` block that releases the lock never
// runs -- every send stayed blocked for the next ~5 minutes until the
// lock's own self-expiry caught up. This proves the tick now stops itself,
// through normal control flow, before that external kill can happen.
describe("runSendTick soft time deadline", () => {
  it("stops early once the soft deadline has elapsed, instead of running unbounded", async () => {
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

    // Deadline already elapsed before the loop even starts -- proves the
    // check actually stops work rather than only existing on paper.
    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true, softDeadlineMs: -1 });

    expect(result.sent).toBe(0);
    expect(result.details.some((d) => d.outcome.includes("soft time deadline"))).toBe(true);
  });
});

describe("runSendTick step-3 variant selection", () => {
  const ARTIST = (slug: string) => `https://www.jaymestone.com/agency/${slug}`;

  function clickRow(contactId: string, label: string, slug: string, clickedAt: string) {
    return { clicked_at: clickedAt, link_tokens: { contact_id: contactId, label, destination_url: ARTIST(slug) } };
  }

  /** A step-3 member plus the three alternative bodies for that step. */
  function variantWorld(clicks: unknown[]) {
    return mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [{ ...account("acc-a"), ramp_schedule: HIGH_RAMP }],
        send_counters: [],
        outbound_sends: [],
        campaign_templates: [
          { campaign_id: "camp-1", step_number: 3, variant: "clicked_focused", subject: "", body: "I think {{Clicked Artists}} could be especially good for your audience." },
          { campaign_id: "camp-1", step_number: 3, variant: "clicked_broad", subject: "", body: "Happy to suggest a few that might be a good fit." },
          { campaign_id: "camp-1", step_number: 3, variant: "no_click", subject: "", body: "Last one from me, I promise." },
        ],
        link_clicks: clicks,
      },
      {
        send_engine_who_is_due: [
          dueMember({ current_step: 2, next_step: 3, body: "DEFAULT BODY", recipient_domain: "a.org", email: "v@a.org" }),
        ],
      },
    );
  }

  it("names the artists a focused clicker actually opened", async () => {
    const supabase = variantWorld([
      clickRow("contact-1", "SUMMER CAMARGO", "summer-camargo", "2026-09-10T10:00:00Z"),
      clickRow("contact-1", "RAKISH", "rakish", "2026-09-10T10:04:00Z"),
    ]);

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(1);
    expect(result.details[0].variant).toBe("clicked_focused");
  });

  it("uses the broad body, naming nobody, once four artists were opened", async () => {
    const supabase = variantWorld(
      ["summer-camargo", "rakish", "lily-henley", "samir-langus"].map((slug, i) =>
        clickRow("contact-1", slug.toUpperCase(), slug, `2026-09-10T10:0${i}:00Z`),
      ),
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(1);
    expect(result.details[0].variant).toBe("clicked_broad");
  });

  it("falls to the no-click body when nothing was genuinely clicked", async () => {
    const result = await runSendTick(variantWorld([]), { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(1);
    expect(result.details[0].variant).toBe("no_click");
  });

  it("ignores scanner traffic, since only human-classified clicks are read", async () => {
    // The query filters click_class='human'; the mock returns whatever it
    // is given, so this asserts the shape rather than the filter. The
    // filter itself is covered in interest.test.ts.
    const result = await runSendTick(variantWorld([]), { dryRun: true, ignoreSendWindow: true });

    expect(result.details[0].variant).toBe("no_click");
  });

  it("leaves campaigns without variants completely alone", async () => {
    const supabase = mockSupabase(
      {
        app_settings: [{ key: "round_robin_cursor", value: -1 }],
        connected_accounts: [{ ...account("acc-a"), ramp_schedule: HIGH_RAMP }],
        send_counters: [],
        outbound_sends: [],
        campaign_templates: [],
        link_clicks: [],
      },
      { send_engine_who_is_due: [dueMember({ body: "PLAIN STEP 2 BODY" })] },
    );

    const result = await runSendTick(supabase, { dryRun: true, ignoreSendWindow: true });

    expect(result.sent).toBe(1);
    expect(result.details[0].variant).toBeUndefined();
  });
});
