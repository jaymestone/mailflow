import { describe, it, expect } from "vitest";
import {
  splitName,
  cleanReferralName,
  shapeContactRows,
  harvestReferralFromReply,
  NO_NAME,
  type HarvestCandidate,
} from "./harvestReferrals";

describe("splitName", () => {
  it("splits an ordinary name", () => {
    expect(splitName("Mallory Wright")).toEqual({ firstName: "Mallory", lastName: "Wright" });
  });

  it("keeps a multi-word surname whole rather than inventing a middle name", () => {
    expect(splitName("Brittany Halberstadt Hoffman")).toEqual({
      firstName: "Brittany",
      lastName: "Halberstadt Hoffman",
    });
  });

  it("handles a lone first name", () => {
    expect(splitName("Bean")).toEqual({ firstName: "Bean", lastName: null });
  });

  it("falls back to Folks when the referral gave only an address", () => {
    // Jayme's convention. The resolver would otherwise render "there",
    // and the existing list already uses "Folks" throughout.
    expect(splitName(null)).toEqual({ firstName: NO_NAME, lastName: null });
    expect(NO_NAME).toBe("Folks");
  });

  it("falls back to Folks when the parsed name was really a job title", () => {
    expect(splitName(cleanReferralName("Interim Director"))).toEqual({ firstName: "Folks", lastName: null });
  });
});

describe("cleanReferralName", () => {
  it("drops job titles that the prose parser mistook for names", () => {
    // Both of these came out of the real run. Writing "Interim Director"
    // into first_name would produce "Hi Interim," on the next send.
    expect(cleanReferralName("Interim Director")).toBeNull();
    expect(cleanReferralName("Adult Enrichment")).toBeNull();
    expect(cleanReferralName("Executive Director")).toBeNull();
  });

  it("keeps real names", () => {
    expect(cleanReferralName("Mallory Wright")).toBe("Mallory Wright");
    expect(cleanReferralName("Heather Fors")).toBe("Heather Fors");
  });

  it("passes null through", () => {
    expect(cleanReferralName(null)).toBeNull();
  });
});

const candidate = (over: Partial<HarvestCandidate> = {}): HarvestCandidate => ({
  email: "successor@venue.org",
  firstName: "Mallory",
  lastName: "Wright",
  venue: "Some Venue",
  venueType: "PAC",
  city: "Austin",
  state: "TX",
  country: "United States",
  listId: "list-original",
  referredBy: "departed@venue.org",
  referral: {
    email: "successor@venue.org",
    name: "Mallory Wright",
    confidence: "high",
    evidence: "Please reach out to Mallory Wright at successor@venue.org.",
    isRoleAddress: false,
  },
  ...over,
});

describe("shapeContactRows", () => {
  it("files the contact in the review list, not the departed contact's list", () => {
    // This is what makes the harvest inert and reviewable. Putting them
    // straight into "Presenters US" would bury 118 unverified addresses
    // among 3,975 real ones.
    const [row] = shapeContactRows([candidate()], "list-pending");

    expect(row.list_id).toBe("list-pending");
    expect(row.notes).toContain("Departed contact's list: list-original");
  });

  it("records who referred them and quotes the evidence", () => {
    const [row] = shapeContactRows([candidate()], "list-pending");

    expect(row.source).toBe("Referral from departed@venue.org (departure auto-reply)");
    expect(row.notes).toContain("Please reach out to Mallory Wright");
    expect(row.notes).toContain("confidence high");
  });

  it("says plainly that nothing is enrolled, since that is the safety property", () => {
    const [row] = shapeContactRows([candidate()], "list-pending");

    expect(row.notes).toContain("Not enrolled in any campaign");
  });

  it("flags a role address so it is not mistaken for a named person", () => {
    const [row] = shapeContactRows(
      [
        candidate({
          email: "info@venue.org",
          firstName: "Folks",
          lastName: null,
          referral: { ...candidate().referral, email: "info@venue.org", isRoleAddress: true, name: null },
        }),
      ],
      "list-pending",
    );

    expect(row.notes).toContain("role address rather than a named person");
    expect(row.first_name).toBe("Folks");
  });

  it("carries venue context through when it is known", () => {
    const [row] = shapeContactRows([candidate()], "list-pending");

    expect(row).toMatchObject({ venue: "Some Venue", city: "Austin", state: "TX", venue_type: "PAC" });
  });

  it("notes the absence of a list rather than writing a misleading one", () => {
    const [row] = shapeContactRows([candidate({ listId: null })], "list-pending");

    expect(row.notes).toContain("No list known for the departed contact");
  });
});

describe("cleanReferralName, committee and transition wording", () => {
  it("drops group labels the prose parser read as names", () => {
    // "Transition Committee" came through the first production dry run and
    // would have been written into first_name.
    expect(cleanReferralName("Transition Committee")).toBeNull();
  });
});

/** Minimal stand-in for the chained calls harvestReferralFromReply makes. */
function mockSupabase(opts: { existingContact?: boolean; suppressed?: boolean; listId?: string } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      if (table === "contacts") {
        return {
          select: () => ({ ilike: () => ({ maybeSingle: async () => ({ data: opts.existingContact ? { id: "c1" } : null, error: null }) }) }),
          insert: async (row: Record<string, unknown>) => {
            inserts.push(row);
            return { data: null, error: null };
          },
        };
      }
      if (table === "suppression") {
        return { select: () => ({ ilike: () => ({ maybeSingle: async () => ({ data: opts.suppressed ? { email: "x" } : null, error: null }) }) }) };
      }
      if (table === "lists") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: opts.listId ?? "list-pending" }, error: null }) }) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as never, inserts };
}

describe("harvestReferralFromReply", () => {
  const body =
    "Thank you for your email. I have left the Grand Theatre. " +
    "Please contact Mallory Wright at mallorywright@grandtheatre.org for booking.";
  const context = { venue: "Grand Theatre", venue_type: "PAC", city: "Austin", state: "TX", country: "United States", list_id: "list-presenters" };

  it("files the successor with no campaign membership", async () => {
    const { client, inserts } = mockSupabase();

    const email = await harvestReferralFromReply(client, { body, senderEmail: "gone@grandtheatre.org", venueContext: context });

    expect(email).toBe("mallorywright@grandtheatre.org");
    expect(inserts).toHaveLength(1);
    // The safety property: a contacts insert and nothing else. No
    // campaign_members table is ever touched, so this cannot send.
    expect(inserts[0]).toMatchObject({
      email: "mallorywright@grandtheatre.org",
      first_name: "Mallory",
      last_name: "Wright",
      venue: "Grand Theatre",
      list_id: "list-pending",
    });
  });

  it("carries the venue context off the departing contact", async () => {
    const { inserts, client } = mockSupabase();
    await harvestReferralFromReply(client, { body, senderEmail: "gone@grandtheatre.org", venueContext: context });
    expect(inserts[0]).toMatchObject({ city: "Austin", state: "TX", venue_type: "PAC" });
    expect(inserts[0].notes).toContain("list-presenters");
  });

  it("declines when the address is already a contact", async () => {
    const { client, inserts } = mockSupabase({ existingContact: true });
    expect(await harvestReferralFromReply(client, { body, senderEmail: "gone@grandtheatre.org", venueContext: context })).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("declines when the address is suppressed, so a prior decision stands", async () => {
    const { client, inserts } = mockSupabase({ suppressed: true });
    expect(await harvestReferralFromReply(client, { body, senderEmail: "gone@grandtheatre.org", venueContext: context })).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("declines when the reply names nobody, without touching the database", async () => {
    const { client, inserts } = mockSupabase();
    const result = await harvestReferralFromReply(client, {
      body: "Thanks for your email, I've moved on. All the best.",
      senderEmail: "gone@grandtheatre.org",
      venueContext: context,
    });
    expect(result).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("uses Folks when only an address was given", async () => {
    const { client, inserts } = mockSupabase();
    await harvestReferralFromReply(client, {
      body: "I have left. For all enquiries please email boxoffice@grandtheatre.org.",
      senderEmail: "gone@grandtheatre.org",
      venueContext: context,
    });
    expect(inserts[0].first_name).toBe("Folks");
  });
});
