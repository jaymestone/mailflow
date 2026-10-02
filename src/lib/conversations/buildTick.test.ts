import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runConversationBuildTick } from "./buildTick";

type Tables = Record<string, Record<string, unknown>[]>;

/** Minimal stand-in for the PostgREST query builder: enough of select /
 * order / range / in to drive the paging reads, plus a capturing upsert. */
function fakeSupabase(tables: Tables) {
  const upserted: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder = {
        select() {
          return builder;
        },
        order() {
          return builder;
        },
        range(from: number, to: number) {
          rows = rows.slice(from, to + 1);
          return builder;
        },
        in(column: string, values: string[]) {
          rows = rows.filter((r) => values.includes(r[column] as string));
          return Promise.resolve({ data: rows, error: null });
        },
        upsert(payload: Record<string, unknown>[]) {
          upserted.push(...payload);
          return Promise.resolve({ error: null });
        },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, upserted };
}

const OWN = [{ email_address: "stone@jaymestone.com" }];

describe("runConversationBuildTick", () => {
  it("merges a conversation split across two Gmail thread ids", async () => {
    // The real Carey Eyer case: ids one character apart, same venue, same
    // subject modulo a Re: prefix. Keyed on the thread id this would be
    // two deals with half the messages each.
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      conversations: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "1a0ca67d421dff24",
          subject: "The Little Mercies",
          from_email: "carey.eyer@gmail.com",
          received_at: "2026-09-20T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
        {
          id: "2",
          gmail_thread_id: "1a0ca67e1ebaa1cb",
          subject: "Re: The Little Mercies",
          from_email: "carey.eyer@gmail.com",
          received_at: "2026-09-24T10:00:00Z",
          matched_contact_id: "contact-1",
          classification_category: "interested",
        },
      ],
    });

    const result = await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(result.conversations).toBe(1);
    expect(upserted).toHaveLength(1);
    expect(upserted[0].gmail_thread_ids).toEqual(
      expect.arrayContaining(["1a0ca67d421dff24", "1a0ca67e1ebaa1cb"]),
    );
    // The contact found on either copy carries onto the merged row.
    expect(upserted[0].contact_id).toBe("contact-1");
    expect(upserted[0].first_inbound_at).toBe("2026-09-20T10:00:00Z");
    expect(upserted[0].last_message_at).toBe("2026-09-24T10:00:00Z");
  });

  it("marks a thread awaiting them once Jayme has actually replied", async () => {
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      conversations: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "t1",
          subject: "Summer series",
          from_email: "booker@venue.org",
          received_at: "2026-09-20T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
      manual_sends: [
        { id: "m1", gmail_thread_id: "t1", subject: "Re: Summer series", from_email: "stone@jaymestone.com", sent_at: "2026-09-21T09:00:00Z" },
      ],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(upserted[0].last_direction).toBe("outbound");
    expect(upserted[0].status).toBe("awaiting_them");
    expect(upserted[0].last_message_at).toBe("2026-09-21T09:00:00Z");
  });

  it("attaches a reply sent from a different account, which has its own thread id", async () => {
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      conversations: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "t1",
          subject: "Winter series",
          from_email: "booker@venue.org",
          received_at: "2026-09-20T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
      manual_sends: [
        // No shared thread id -- only the subject ties it to the enquiry.
        { id: "m1", gmail_thread_id: "t-other", subject: "RE: Winter series", from_email: "agency@jaymestone.com", sent_at: "2026-09-22T09:00:00Z" },
      ],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(upserted[0].last_direction).toBe("outbound");
    expect(upserted[0].gmail_thread_ids).toEqual(expect.arrayContaining(["t1", "t-other"]));
  });

  it("excludes lead-gen spam that was classified interested before the filter existed", async () => {
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      conversations: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "s1",
          subject: "Jayme, let's talk about it. | 93360X6 DVQ84BR",
          from_email: "hermann@getficonto.de",
          received_at: "2026-09-20T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
    });

    const result = await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(result.spamSkipped).toBe(1);
    expect(result.conversations).toBe(0);
    expect(upserted).toHaveLength(0);
  });

  it("keeps Jayme's own correction instead of recomputing over it", async () => {
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "t1",
          subject: "Autumn dates",
          from_email: "booker@venue.org",
          received_at: "2026-09-29T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
      conversations: [
        {
          id: "c1",
          thread_key: "booker@venue.org::autumn dates",
          status_override: "confirmed",
          fee_amount: null,
          revision: 4,
          is_live: true,
          last_message_at: "2026-09-29T10:00:00Z",
        },
      ],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    // Computed status would be needs_reply; his override stands.
    expect(upserted[0].status).toBe("confirmed");
    expect(upserted[0].revision).toBe(5);
  });

  it("drops a silent thread with no money attached, and keeps one with a fee", async () => {
    const quiet = {
      id: "1",
      gmail_thread_id: "t1",
      subject: "Old enquiry",
      from_email: "a@venue.org",
      received_at: "2026-07-01T10:00:00Z",
      matched_contact_id: null,
      classification_category: "interested",
    };
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      conversations: [{ id: "c2", thread_key: "b@venue.org::priced enquiry", status_override: null, fee_amount: 4000, revision: 1, is_live: true, last_message_at: "2026-07-01T10:00:00Z" }],
      inbound_messages: [
        quiet,
        { ...quiet, id: "2", gmail_thread_id: "t2", subject: "Priced enquiry", from_email: "b@venue.org" },
      ],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    const byKey = Object.fromEntries(upserted.map((r) => [r.thread_key, r]));
    expect(byKey["a@venue.org::old enquiry"].is_live).toBe(false);
    expect(byKey["b@venue.org::priced enquiry"].is_live).toBe(true);
  });
});

describe("runConversationBuildTick status preservation", () => {
  it("does not reset a confirmed deal back to numbers_on_table", async () => {
    // The build pass cannot see is_agreed -- it lives in the summariser's
    // output -- so it used to pass false and clobber Confirmed on every
    // tick, which ran before the summariser on all rows. The board showed
    // zero confirmed bookings while the model was correctly reporting
    // Blue Waters as agreed.
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "t1",
          subject: "The Little Mercies",
          from_email: "carey.eyer@gmail.com",
          received_at: "2026-09-29T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
      conversations: [
        {
          id: "c1",
          thread_key: "carey.eyer@gmail.com::the little mercies",
          status: "confirmed",
          status_override: null,
          fee_amount: 3500,
          revision: 2,
          is_live: true,
          last_message_at: "2026-09-29T10:00:00Z",
        },
      ],
      contacts: [],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(upserted[0].status).toBe("confirmed");
  });

  it("keeps a parked deal parked", async () => {
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "t1",
          subject: "Small show",
          from_email: "a@venue.org",
          received_at: "2026-09-29T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
      conversations: [
        {
          id: "c1",
          thread_key: "a@venue.org::small show",
          status: "parked",
          status_override: null,
          fee_amount: null,
          revision: 2,
          is_live: true,
          last_message_at: "2026-09-29T10:00:00Z",
        },
      ],
      contacts: [],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(upserted[0].status).toBe("parked");
  });

  it("still flips direction on a conversation the summariser has not judged", async () => {
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "t1",
          subject: "Autumn",
          from_email: "a@venue.org",
          received_at: "2026-09-29T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
      manual_sends: [
        { id: "m1", gmail_thread_id: "t1", subject: "Re: Autumn", from_email: "stone@jaymestone.com", sent_at: "2026-09-30T10:00:00Z" },
      ],
      conversations: [
        {
          id: "c1",
          thread_key: "a@venue.org::autumn",
          status: "needs_reply",
          status_override: null,
          fee_amount: null,
          revision: 1,
          is_live: true,
          last_message_at: "2026-09-29T10:00:00Z",
        },
      ],
      contacts: [],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(upserted[0].status).toBe("awaiting_them");
  });
});

describe("runConversationBuildTick field preservation", () => {
  it("does not wipe a venue the summariser supplied for an unmatched thread", async () => {
    // PostgREST normalises a bulk upsert to the union of the keys it is
    // given and writes NULL into any a row omitted. Including venue only
    // when a contact matched therefore erased it rather than leaving it
    // alone, and confirmed deals were appearing with no venue name.
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      contacts: [],
      inbound_messages: [
        {
          id: "1",
          gmail_thread_id: "t1",
          subject: "The Little Mercies",
          from_email: "carey.eyer@gmail.com",
          received_at: "2026-09-29T10:00:00Z",
          matched_contact_id: null,
          classification_category: "interested",
        },
      ],
      conversations: [
        {
          id: "c1",
          thread_key: "carey.eyer@gmail.com::the little mercies",
          status: "confirmed",
          status_override: null,
          venue: "Blue Waters Bluegrass Festival",
          region: "West Coast",
          fee_amount: 3500,
          revision: 3,
          is_live: true,
          last_message_at: "2026-09-29T10:00:00Z",
        },
      ],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(upserted[0].venue).toBe("Blue Waters Bluegrass Festival");
    expect(upserted[0].region).toBe("West Coast");
  });

  it("writes the same keys for every row in the batch", async () => {
    // The actual invariant: a mixed batch where only some rows have a
    // contact must not produce rows with differing key sets.
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      conversations: [],
      contacts: [{ id: "k1", venue: "Known Hall", state: "TX", country: "United States" }],
      inbound_messages: [
        {
          id: "1", gmail_thread_id: "t1", subject: "Matched", from_email: "a@venue.org",
          received_at: "2026-09-29T10:00:00Z", matched_contact_id: "k1", classification_category: "interested",
        },
        {
          id: "2", gmail_thread_id: "t2", subject: "Unmatched", from_email: "b@venue.org",
          received_at: "2026-09-29T10:00:00Z", matched_contact_id: null, classification_category: "interested",
        },
      ],
    });

    await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });

    expect(upserted).toHaveLength(2);
    expect(Object.keys(upserted[0]).sort()).toEqual(Object.keys(upserted[1]).sort());
  });
});

describe("runConversationBuildTick revision", () => {
  const INBOUND = [
    {
      id: "1",
      gmail_thread_id: "t1",
      subject: "The Little Mercies",
      from_email: "carey.eyer@gmail.com",
      received_at: "2026-09-29T10:00:00Z",
      matched_contact_id: null,
      classification_category: "interested",
    },
  ];
  const THREAD_KEY = "carey.eyer@gmail.com::the little mercies";

  /** A stored row that already matches exactly what this pass would
   * compute from INBOUND -- so nothing Notion shows has moved. */
  const settled = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    thread_key: THREAD_KEY,
    status: "needs_reply",
    status_override: null,
    venue: null,
    region: null,
    fee_amount: null,
    revision: 412,
    is_live: true,
    last_message_at: "2026-09-29T10:00:00Z",
    last_direction: "inbound",
    ...over,
  });

  const build = async (conversations: Record<string, unknown>[]) => {
    const { client, upserted } = fakeSupabase({
      connected_accounts: OWN,
      manual_sends: [],
      inbound_messages: INBOUND,
      conversations,
      contacts: [],
    });
    const result = await runConversationBuildTick(client, { now: new Date("2026-10-01T00:00:00Z") });
    return { upserted, result };
  };

  // The bug this closes: revision was bumped on every pass regardless, so
  // with this running every minute and the Notion sync clearing ~30 rows a
  // quarter hour, every row was permanently ahead of Notion and `pending`
  // could never reach zero.
  it("leaves the revision alone when nothing Notion shows has moved", async () => {
    const { upserted, result } = await build([settled()]);

    expect(upserted[0].revision).toBe(412);
    expect(result.changed).toBe(0);
  });

  it("bumps the revision when a new message arrives", async () => {
    const { upserted, result } = await build([settled({ last_message_at: "2026-09-20T10:00:00Z" })]);

    expect(upserted[0].revision).toBe(413);
    expect(result.changed).toBe(1);
  });

  it("bumps the revision when the status changes", async () => {
    const { upserted, result } = await build([settled({ status: "awaiting_them" })]);

    expect(upserted[0].revision).toBe(413);
    expect(result.changed).toBe(1);
  });

  it("starts a brand-new conversation at revision 1", async () => {
    const { upserted, result } = await build([]);

    expect(upserted[0].revision).toBe(1);
    expect(result.changed).toBe(1);
  });
});
