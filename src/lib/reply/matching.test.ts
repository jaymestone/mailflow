import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchInboundMessage } from "./matching";
import type { ParsedEmail } from "./types";

type Filters = Record<string, unknown>;
type Resolver = (table: string, filters: Filters) => Record<string, unknown> | null;

/** Minimal stand-in for the chained `.from().select().eq()...maybeSingle()`
 * query builder — records every `.eq()`/`.ilike()` filter applied, then
 * hands the table name and accumulated filters to a per-test `resolver`
 * when the chain is finally awaited, so each test can control exactly
 * which query "finds" a row without needing a real database.
 *
 * Resolving works two ways because the real code uses both shapes: via
 * `.maybeSingle()` (one row or null) and by awaiting the builder itself
 * (a list) — the tier-3 contact lookup does the latter, since it filters
 * with ilike and then re-checks the case in JS. */
class MockQuery {
  private filters: Filters = {};
  constructor(
    private table: string,
    private resolver: Resolver,
  ) {}
  select() {
    return this;
  }
  eq(field: string, value: unknown) {
    this.filters[field] = value;
    return this;
  }
  /** Recorded under the same key as `.eq()` so a resolver can treat them
   * alike; the wildcard-escaping the real query applies is undone here so
   * tests can match on the plain address. */
  ilike(field: string, value: unknown) {
    this.filters[field] = typeof value === "string" ? value.replace(/\\([%_\\])/g, "$1") : value;
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  async maybeSingle() {
    return { data: this.resolver(this.table, this.filters), error: null };
  }
  then<T>(resolve: (v: { data: unknown[]; error: null }) => T): T {
    const row = this.resolver(this.table, this.filters);
    return resolve({ data: row ? [row] : [], error: null });
  }
}

function mockSupabase(resolver: Resolver): SupabaseClient {
  return { from: (table: string) => new MockQuery(table, resolver) } as unknown as SupabaseClient;
}

function email(overrides: Partial<ParsedEmail>): ParsedEmail {
  return {
    gmailMessageId: "msg-1",
    gmailThreadId: "thread-1",
    fromEmail: "venue@example.com",
    fromName: "Venue Person",
    subject: "Re: something",
    bodyText: "Sounds good.",
    receivedAt: "2026-08-24T10:00:00Z",
    inReplyTo: null,
    references: [],
    labelIds: [],
    ...overrides,
  };
}

describe("matchInboundMessage", () => {
  it("matches on In-Reply-To against a stored rfc_message_id (tier 1)", async () => {
    const supabase = mockSupabase((table, filters) => {
      if (table === "outbound_sends" && filters.rfc_message_id === "<abc@x>") {
        return { id: "send-1", campaign_id: "camp-1", contact_id: "contact-1" };
      }
      return null;
    });
    const result = await matchInboundMessage(supabase, email({ inReplyTo: "<abc@x>" }));
    expect(result).toEqual({
      campaignId: "camp-1",
      contactId: "contact-1",
      outboundSendId: "send-1",
      matchMethod: "message_id",
      alsoImplicatedContactIds: [],
    });
  });

  it("falls through to a References entry when In-Reply-To doesn't match", async () => {
    const supabase = mockSupabase((table, filters) => {
      if (table === "outbound_sends" && filters.rfc_message_id === "<second@x>") {
        return { id: "send-2", campaign_id: "camp-2", contact_id: "contact-2" };
      }
      return null;
    });
    const result = await matchInboundMessage(
      supabase,
      email({ inReplyTo: "<missing@x>", references: ["<first@x>", "<second@x>"] }),
    );
    expect(result.matchMethod).toBe("message_id");
    expect(result.outboundSendId).toBe("send-2");
  });

  it("falls back to the tracking token embedded in the reply body (tier 2)", async () => {
    const supabase = mockSupabase((table, filters) => {
      if (table === "outbound_sends" && filters.tracking_token === "9055d234bfc054df") {
        return { id: "send-3", campaign_id: "camp-3", contact_id: "contact-3" };
      }
      return null; // no rfc_message_id lookup ever matches
    });
    const result = await matchInboundMessage(
      supabase,
      email({
        inReplyTo: "<unrelated@x>",
        bodyText: "Thanks!\n\n<!-- 9055d234bfc054df -->",
      }),
    );
    expect(result).toEqual({
      campaignId: "camp-3",
      contactId: "contact-3",
      outboundSendId: "send-3",
      matchMethod: "tracking_token",
      alsoImplicatedContactIds: [],
    });
  });

  it("matches the tracking token case-insensitively", async () => {
    const supabase = mockSupabase((table, filters) => {
      if (table === "outbound_sends" && filters.tracking_token === "abc123def4567890") {
        return { id: "send-4", campaign_id: "camp-4", contact_id: "contact-4" };
      }
      return null;
    });
    const result = await matchInboundMessage(supabase, email({ bodyText: "<!-- ABC123DEF4567890 -->" }));
    expect(result.matchMethod).toBe("tracking_token");
  });

  it("falls back to sender email against an active campaign member (tier 3)", async () => {
    const supabase = mockSupabase((table, filters) => {
      if (table === "contacts" && filters.email === "venue@example.com") {
        return { id: "contact-5", email: "venue@example.com" };
      }
      if (table === "campaign_members" && filters.contact_id === "contact-5" && filters.member_status === "active") {
        return { campaign_id: "camp-5", contact_id: "contact-5" };
      }
      return null;
    });
    const result = await matchInboundMessage(supabase, email({ fromEmail: "venue@example.com" }));
    expect(result).toEqual({
      campaignId: "camp-5",
      contactId: "contact-5",
      outboundSendId: null,
      matchMethod: "sender_email",
      alsoImplicatedContactIds: [],
    });
  });

  // Confirmed live 2026-09-22: a contact stored as
  // `Josh@OtterCreekMusicFestival.com` replied from the all-lowercase
  // form with a genuinely interested message. The old exact-match `.eq()`
  // missed it, so the reply stayed unmatched and the send engine -- which
  // only skips members whose reply actually matched -- kept him queued for
  // automated follow-ups. 376 of ~6,270 contacts had uppercase in their
  // stored address, so this was a standing ~6% hole, not an edge case.
  it("matches the sender email case-insensitively (tier 3)", async () => {
    const supabase = mockSupabase((table, filters) => {
      // Resolver compares case-insensitively, standing in for ilike.
      if (
        table === "contacts" &&
        String(filters.email).toLowerCase() === "josh@ottercreekmusicfestival.com"
      ) {
        return { id: "contact-7", email: "Josh@OtterCreekMusicFestival.com" };
      }
      if (table === "campaign_members" && filters.contact_id === "contact-7" && filters.member_status === "active") {
        return { campaign_id: "camp-7", contact_id: "contact-7" };
      }
      return null;
    });
    const result = await matchInboundMessage(
      supabase,
      email({ fromEmail: "josh@ottercreekmusicfestival.com" }),
    );
    expect(result).toEqual({
      campaignId: "camp-7",
      contactId: "contact-7",
      outboundSendId: null,
      matchMethod: "sender_email",
      alsoImplicatedContactIds: [],
    });
  });

  // ilike treats % and _ as wildcards. Without escaping, a reply from an
  // address containing either could match a *different* contact and
  // attribute the reply -- and any resulting pause/suppress -- to the
  // wrong person. The JS re-check is the backstop that makes this safe.
  it("does not let ilike wildcards in the sender address match a different contact", async () => {
    const supabase = mockSupabase((table) => {
      if (table === "contacts") {
        // A naive ilike would let `a_b@x.com` match `aXb@x.com`; the
        // resolver returns that wrong-but-wildcard-compatible row.
        return { id: "contact-wrong", email: "aXb@x.com" };
      }
      if (table === "campaign_members") return { campaign_id: "camp-wrong", contact_id: "contact-wrong" };
      return null;
    });
    const result = await matchInboundMessage(supabase, email({ fromEmail: "a_b@x.com" }));
    expect(result.matchMethod).toBe("unmatched");
    expect(result.contactId).toBeNull();
  });

  it("returns unmatched when the sender's contact has no active campaign membership", async () => {
    const supabase = mockSupabase((table, filters) => {
      if (table === "contacts" && filters.email === "venue@example.com") {
        return { id: "contact-6", email: "venue@example.com" };
      }
      return null; // no active campaign_members row
    });
    const result = await matchInboundMessage(supabase, email({ fromEmail: "venue@example.com" }));
    expect(result.matchMethod).toBe("unmatched");
  });

  it("returns unmatched when nothing matches at any tier", async () => {
    const supabase = mockSupabase(() => null);
    const result = await matchInboundMessage(supabase, email({}));
    expect(result).toEqual({
      campaignId: null,
      contactId: null,
      outboundSendId: null,
      matchMethod: "unmatched",
      alsoImplicatedContactIds: [],
    });
  });
});

// The live failure of 2026-09-28. We mailed monag@pricechopper.com
// (contact "Second Wind Productions"); pricechopper.com forwards, so Mona
// replied from mgolub@northeastsharedservices.com, which the list held as
// a SEPARATE contact record for the same person. The forwarder also
// rewrote the threading headers, so tiers 1 and 2 found nothing and the
// sender fallback credited the reply to the record that was never mailed.
// The mailed record kept going and sent a second cold pitch 12 days after
// she replied "interested".
const FORWARDED_REPLY = `Jayme,

I retired Second Wind Productions in 2004 to concentrate on Music Haven.

Thanks,
MJG

From: Jayme Stone <agency@jaymestone.com>
Sent: Wednesday, September 16, 2026 9:25 AM
To: monag@pricechopper.com
Subject: New Roster X Second Wind Productions`;

/** Both records exist, both are active members, no header matches. */
function splitRecordDb(): SupabaseClient {
  return mockSupabase((table, filters) => {
    if (table === "contacts") {
      if (filters.email === "mgolub@northeastsharedservices.com")
        return { id: "contact-music-haven", email: "mgolub@northeastsharedservices.com" };
      if (filters.email === "monag@pricechopper.com")
        return { id: "contact-second-wind", email: "monag@pricechopper.com" };
      return null;
    }
    if (table === "campaign_members" && filters.member_status === "active") {
      return { campaign_id: "camp-roster", contact_id: filters.contact_id };
    }
    return null; // no rfc_message_id / tracking_token ever matches
  });
}

describe("matchInboundMessage — one human under two contact records", () => {
  it("credits the record that was actually mailed, not the one that replied", async () => {
    const result = await matchInboundMessage(
      splitRecordDb(),
      email({
        fromEmail: "mgolub@northeastsharedservices.com",
        bodyText: FORWARDED_REPLY,
        inReplyTo: "<CAKzgW0s@mail.gmail.com>",
      }),
    );

    expect(result.matchMethod).toBe("quoted_recipient");
    expect(result.contactId).toBe("contact-second-wind");
  });

  it("also reports the replying record, so its sequence can be stopped too", async () => {
    const result = await matchInboundMessage(
      splitRecordDb(),
      email({
        fromEmail: "mgolub@northeastsharedservices.com",
        bodyText: FORWARDED_REPLY,
      }),
    );

    expect(result.alsoImplicatedContactIds).toEqual(["contact-music-haven"]);
  });

  it("reports the second record even when the headers DID match", async () => {
    // Tier 1 resolves the mailed record correctly, but the duplicate is
    // still sitting there active and still needs stopping.
    const supabase = mockSupabase((table, filters) => {
      if (table === "outbound_sends" && filters.rfc_message_id === "<ours@jaymestoneagency.com>") {
        return { id: "send-1", campaign_id: "camp-roster", contact_id: "contact-second-wind" };
      }
      if (table === "contacts" && filters.email === "mgolub@northeastsharedservices.com") {
        return { id: "contact-music-haven", email: "mgolub@northeastsharedservices.com" };
      }
      if (table === "contacts" && filters.email === "monag@pricechopper.com") {
        return { id: "contact-second-wind", email: "monag@pricechopper.com" };
      }
      if (table === "campaign_members" && filters.member_status === "active") {
        return { campaign_id: "camp-roster", contact_id: filters.contact_id };
      }
      return null;
    });

    const result = await matchInboundMessage(
      supabase,
      email({
        fromEmail: "mgolub@northeastsharedservices.com",
        bodyText: FORWARDED_REPLY,
        inReplyTo: "<ours@jaymestoneagency.com>",
      }),
    );

    expect(result.matchMethod).toBe("message_id");
    expect(result.contactId).toBe("contact-second-wind");
    expect(result.alsoImplicatedContactIds).toEqual(["contact-music-haven"]);
  });

  it("stays on sender_email when the quoted recipient is the same contact", async () => {
    // The ordinary case: no forwarding, the address we mailed is the
    // address that replied. Nothing about tier 3 should change.
    const supabase = mockSupabase((table, filters) => {
      if (table === "contacts" && filters.email === "venue@example.com") {
        return { id: "contact-7", email: "venue@example.com" };
      }
      if (table === "campaign_members" && filters.member_status === "active") {
        return { campaign_id: "camp-7", contact_id: "contact-7" };
      }
      return null;
    });

    const result = await matchInboundMessage(
      supabase,
      email({
        fromEmail: "venue@example.com",
        bodyText: "Sure.\n\nFrom: Jayme\nTo: venue@example.com\nSubject: x",
      }),
    );

    expect(result.matchMethod).toBe("sender_email");
    expect(result.contactId).toBe("contact-7");
    expect(result.alsoImplicatedContactIds).toEqual([]);
  });

  it("ignores a quoted recipient that is not a contact we hold", async () => {
    // A cc'd colleague in the quoted headers must not hijack attribution.
    const supabase = mockSupabase((table, filters) => {
      if (table === "contacts" && filters.email === "venue@example.com") {
        return { id: "contact-7", email: "venue@example.com" };
      }
      if (table === "campaign_members" && filters.member_status === "active") {
        return { campaign_id: "camp-7", contact_id: "contact-7" };
      }
      return null;
    });

    const result = await matchInboundMessage(
      supabase,
      email({
        fromEmail: "venue@example.com",
        bodyText: "Sure.\n\nFrom: Jayme\nTo: stranger@nowhere.org\nSubject: x",
      }),
    );

    expect(result.matchMethod).toBe("sender_email");
    expect(result.contactId).toBe("contact-7");
  });

  it("does not implicate a duplicate that has no active membership", async () => {
    // Already paused or already replied — nothing to stop, so it must not
    // be reported and the caller does not have to re-check.
    const supabase = mockSupabase((table, filters) => {
      if (table === "outbound_sends" && filters.rfc_message_id === "<ours@jaymestoneagency.com>") {
        return { id: "send-1", campaign_id: "camp-roster", contact_id: "contact-second-wind" };
      }
      if (table === "contacts" && filters.email === "mgolub@northeastsharedservices.com") {
        return { id: "contact-music-haven", email: "mgolub@northeastsharedservices.com" };
      }
      return null; // no active membership for anyone
    });

    const result = await matchInboundMessage(
      supabase,
      email({
        fromEmail: "mgolub@northeastsharedservices.com",
        bodyText: FORWARDED_REPLY,
        inReplyTo: "<ours@jaymestoneagency.com>",
      }),
    );

    expect(result.alsoImplicatedContactIds).toEqual([]);
  });
});
