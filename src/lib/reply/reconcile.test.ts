import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReconcileTick } from "./reconcile";

type Msg = {
  id: string;
  from_email: string;
  subject: string | null;
  classification_category: string | null;
  message_type: string;
  ooo_return_date: string | null;
  received_at: string;
};

type Writes = {
  inboundUpdates: Record<string, unknown>[];
  memberUpdates: Record<string, unknown>[];
  suppressionInserts: Record<string, unknown>[];
};

/** Builds a Supabase stand-in around a fixed world: some unmatched
 * messages, a contacts table, and which contacts have an active
 * membership. Records every write so tests can assert on exactly what the
 * reconciler did -- and, just as importantly, what it declined to do. */
function mockSupabase(opts: {
  messages: Msg[];
  contacts: { id: string; email: string; venue: string | null }[];
  activeContactIds: string[];
  alreadySuppressed?: string[];
  /** received_at of an already-matched message per contact id, used to
   * exercise the stale-instruction guard. */
  existingMatchedAt?: Record<string, string>;
  writes: Writes;
}): SupabaseClient {
  const { messages, contacts, activeContactIds, alreadySuppressed = [], existingMatchedAt = {}, writes } = opts;

  return {
    from: (table: string) => {
      if (table === "inbound_messages") {
        return {
          select: () => ({
            // The reconciler issues two differently-shaped selects on this
            // table: the unmatched sweep (.eq.in.gte.order.limit) and the
            // stale-guard lookup (.eq.gte.limit.maybeSingle).
            eq: (_col: string, value: string) => ({
              in: () => ({
                gte: () => ({
                  order: () => ({ limit: async () => ({ data: messages, error: null }) }),
                }),
              }),
              gte: (_c: string, receivedAt: string) => ({
                limit: () => ({
                  maybeSingle: async () => {
                    const at = existingMatchedAt[value];
                    return { data: at && at >= receivedAt ? { received_at: at } : null, error: null };
                  },
                }),
              }),
            }),
          }),
          update: (fields: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              writes.inboundUpdates.push({ id, ...fields });
              return { data: null, error: null };
            },
          }),
        };
      }
      if (table === "contacts") {
        return {
          select: () => ({
            ilike: (_col: string, pattern: string) => ({
              limit: async () => {
                const wanted = pattern.replace(/\\([%_\\])/g, "$1").toLowerCase();
                return { data: contacts.filter((c) => c.email.toLowerCase() === wanted), error: null };
              },
            }),
          }),
        };
      }
      if (table === "campaign_members") {
        return {
          select: () => ({
            eq: (_c: string, contactId: string) => ({
              eq: async () => ({
                data: activeContactIds.includes(contactId) ? [{ id: `cm-${contactId}`, campaign_id: "camp-1" }] : [],
                error: null,
              }),
            }),
          }),
          update: (fields: Record<string, unknown>) => ({
            eq: (_c: string, contactId: string) => ({
              eq: async () => {
                writes.memberUpdates.push({ contactId, ...fields });
                return { data: null, error: null };
              },
            }),
          }),
        };
      }
      if (table === "suppression") {
        return {
          select: () => ({
            ilike: (_c: string, e: string) => ({
              maybeSingle: async () => ({
                data: alreadySuppressed.includes(e.toLowerCase()) ? { id: "sup-1" } : null,
                error: null,
              }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            writes.suppressionInserts.push(row);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

function freshWrites(): Writes {
  return { inboundUpdates: [], memberUpdates: [], suppressionInserts: [] };
}

function msg(over: Partial<Msg> = {}): Msg {
  return {
    id: "m1",
    from_email: "venue@example.com",
    subject: "Re: New Roster",
    classification_category: "interested",
    message_type: "reply",
    ooo_return_date: null,
    received_at: "2026-09-22T12:00:00Z",
    ...over,
  };
}

const CONTACT = { id: "c1", email: "Venue@Example.com", venue: "The Venue" };

describe("runReconcileTick", () => {
  it("records the match for a reply whose sender is a real, still-active contact", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg()],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase);

    expect(result.repaired).toBe(1);
    expect(writes.inboundUpdates).toEqual([
      { id: "m1", matched_contact_id: "c1", matched_campaign_id: "camp-1", match_method: "sender_email" },
    ]);
  });

  // The whole point of the safety net: matching failed for a mundane
  // reason (here, letter case), but the contact is plainly real.
  it("resolves the sender case-insensitively", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ from_email: "VENUE@example.COM" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase);
    expect(result.repaired).toBe(1);
  });

  it("leaves alone a sender who isn't a contact at all", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ from_email: "stranger@nowhere.com" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase);
    expect(result.repaired).toBe(0);
    expect(writes.inboundUpdates).toEqual([]);
  });

  it("leaves alone a contact who is no longer active in any campaign", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg()],
      contacts: [CONTACT],
      activeContactIds: [], // already paused/finished
      writes,
    });

    const result = await runReconcileTick(supabase);
    expect(result.repaired).toBe(0);
    expect(writes.inboundUpdates).toEqual([]);
  });

  it("suppresses and pauses a departed reply", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ classification_category: "ooo_departed" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase);

    expect(result.departedSuppressed).toBe(1);
    expect(writes.suppressionInserts[0]).toMatchObject({ email: "Venue@Example.com", reason: "departed" });
    expect(writes.memberUpdates).toEqual([{ contactId: "c1", member_status: "paused" }]);
  });

  it("does not double-suppress someone already on the suppression list", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ classification_category: "ooo_departed" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      alreadySuppressed: ["venue@example.com"],
      writes,
    });

    await runReconcileTick(supabase);
    expect(writes.suppressionInserts).toEqual([]);
    // Still paused, though -- that part isn't conditional.
    expect(writes.memberUpdates).toEqual([{ contactId: "c1", member_status: "paused" }]);
  });

  it("snoozes an out-of-office reply to its stated return date", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ classification_category: "ooo_temporary", ooo_return_date: "2099-01-15" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase);

    expect(result.oooSnoozed).toBe(1);
    const update = writes.memberUpdates[0];
    expect(update.contactId).toBe("c1");
    expect(String(update.resume_at)).toContain("2099-01-15");
    // Snoozed, never suppressed -- they're coming back.
    expect(writes.suppressionInserts).toEqual([]);
  });

  // The line this must not cross. An interested reply is a live business
  // decision; the reconciler stops the sequence and stops there.
  it("records the match for an interested reply but takes no judgement action", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ classification_category: "interested" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase);

    expect(result.matchedOnly).toBe(1);
    expect(writes.inboundUpdates).toHaveLength(1); // sequence stopped
    expect(writes.suppressionInserts).toEqual([]); // never suppressed
    expect(writes.memberUpdates).toEqual([]); // never paused or snoozed
    expect(result.needsHuman).toEqual([
      { email: "Venue@Example.com", venue: "The Venue", category: "interested", subject: "Re: New Roster" },
    ]);
  });

  // The guard that makes this safe to run unattended. Without it, an old
  // "I've left the organisation" could suppress a contact who has since
  // replied with interest.
  it("records the match but refuses to act on a message older than an already-matched reply", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ id: "stale", classification_category: "ooo_departed", received_at: "2026-09-01T12:00:00Z" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      // A newer reply already matched and drove the current state.
      existingMatchedAt: { c1: "2026-09-20T12:00:00Z" },
      writes,
    });

    const result = await runReconcileTick(supabase);

    expect(writes.inboundUpdates).toHaveLength(1); // data still tidied
    expect(result.matchedOnly).toBe(1);
    expect(result.departedSuppressed).toBe(0);
    expect(writes.suppressionInserts).toEqual([]); // the stale instruction is NOT applied
    expect(writes.memberUpdates).toEqual([]);
  });

  it("still acts when the already-matched reply is older than this one", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ classification_category: "ooo_departed", received_at: "2026-09-20T12:00:00Z" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      existingMatchedAt: { c1: "2026-09-01T12:00:00Z" },
      writes,
    });

    const result = await runReconcileTick(supabase);
    expect(result.departedSuppressed).toBe(1);
  });

  it("dry run reports what it would do without writing anything", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [msg({ classification_category: "ooo_departed" })],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase, { dryRun: true });

    expect(result.repaired).toBe(1);
    expect(writes.inboundUpdates).toEqual([]);
    expect(writes.memberUpdates).toEqual([]);
    expect(writes.suppressionInserts).toEqual([]);
  });

  it("handles only the newest message per sender", async () => {
    const writes = freshWrites();
    const supabase = mockSupabase({
      messages: [
        msg({ id: "new", received_at: "2026-09-22T12:00:00Z" }),
        msg({ id: "old", received_at: "2026-09-20T12:00:00Z" }),
      ],
      contacts: [CONTACT],
      activeContactIds: ["c1"],
      writes,
    });

    const result = await runReconcileTick(supabase);
    expect(result.repaired).toBe(1);
    expect(writes.inboundUpdates.map((u) => u.id)).toEqual(["new"]);
  });

  it("keeps going when one sender errors, instead of aborting the run", async () => {
    const writes = freshWrites();
    const messages = [msg({ id: "boom", from_email: "boom@example.com" }), msg({ id: "ok" })];
    const contacts = [CONTACT, { id: "c2", email: "boom@example.com", venue: "Boom" }];

    const supabase = {
      from: (table: string) => {
        if (table === "contacts") {
          return {
            select: () => ({
              ilike: (_c: string, pattern: string) => ({
                limit: async () => {
                  if (pattern.includes("boom")) throw new Error("transient lookup failure");
                  const wanted = pattern.replace(/\\([%_\\])/g, "$1").toLowerCase();
                  return { data: contacts.filter((c) => c.email.toLowerCase() === wanted), error: null };
                },
              }),
            }),
          };
        }
        return mockSupabase({ messages, contacts, activeContactIds: ["c1", "c2"], writes }).from(table);
      },
    } as unknown as SupabaseClient;

    const result = await runReconcileTick(supabase);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].email).toBe("boom@example.com");
    expect(result.repaired).toBe(1); // the healthy one still went through
  });
});
