import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchInboundMessage } from "./matching";
import type { ParsedEmail } from "./types";

type Filters = Record<string, unknown>;
type Resolver = (table: string, filters: Filters) => Record<string, unknown> | null;

/** Minimal stand-in for the chained `.from().select().eq()...maybeSingle()`
 * query builder — records every `.eq()` filter applied, then hands the
 * table name and accumulated filters to a per-test `resolver` when the
 * chain is finally awaited, so each test can control exactly which query
 * "finds" a row without needing a real database. */
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
  order() {
    return this;
  }
  limit() {
    return this;
  }
  async maybeSingle() {
    return { data: this.resolver(this.table, this.filters), error: null };
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
      if (table === "contacts" && filters.email === "venue@example.com") return { id: "contact-5" };
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
    });
  });

  it("returns unmatched when the sender's contact has no active campaign membership", async () => {
    const supabase = mockSupabase((table, filters) => {
      if (table === "contacts" && filters.email === "venue@example.com") return { id: "contact-6" };
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
    });
  });
});
