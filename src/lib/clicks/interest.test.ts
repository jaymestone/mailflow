import { describe, it, expect } from "vitest";
import { bucketFor, displayArtistName, resolveInterest } from "./interest";

describe("bucketFor", () => {
  it("routes by how many artists were genuinely opened", () => {
    expect(bucketFor(0)).toBe("no_click");
    expect(bucketFor(1)).toBe("clicked_focused");
    expect(bucketFor(3)).toBe("clicked_focused");
    // Four or more is effectively "read the whole roster" -- naming three
    // of ten would be arbitrary, so that variant doesn't name any.
    expect(bucketFor(4)).toBe("clicked_broad");
    expect(bucketFor(10)).toBe("clicked_broad");
  });
});

describe("displayArtistName", () => {
  it("turns template link text into something a person would write", () => {
    expect(displayArtistName("SUMMER CAMARGO")).toBe("Summer Camargo");
    expect(displayArtistName("THE LITTLE MERCIES")).toBe("The Little Mercies");
    expect(displayArtistName("JORGE GLEM & SAM REIDER")).toBe("Jorge Glem & Sam Reider");
    expect(displayArtistName("SAM REIDER & THE HUMAN HANDS")).toBe("Sam Reider & The Human Hands");
  });
});

/** Minimal stand-in for the chained query resolveInterest makes. Records
 * the id lists it was asked for, so chunking can be asserted. */
function mockSupabase(rows: unknown[], error: { message: string } | null = null) {
  const calls: string[][] = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: (_col: string, ids: string[]) => {
      calls.push(ids);
      // Only return rows belonging to the ids this chunk asked for, the
      // way the real query would.
      const wanted = new Set(ids);
      const mine = (rows as { link_tokens?: { contact_id?: string } }[]).filter(
        (r) => r.link_tokens?.contact_id && wanted.has(r.link_tokens.contact_id),
      );
      return Promise.resolve({ data: mine, error });
    },
  };
  return Object.assign({ from: () => builder } as never, { __calls: calls }) as never & { __calls: string[][] };
}

const ARTIST = (slug: string) => `https://www.jaymestone.com/agency/${slug}`;
const ROSTER_INDEX = "https://www.jaymestone.com/agency";

function click(contactId: string, label: string, url: string, clickedAt: string) {
  return { clicked_at: clickedAt, link_tokens: { contact_id: contactId, label, destination_url: url } };
}

describe("resolveInterest", () => {
  it("defaults everyone to no_click, including contacts with no rows at all", async () => {
    const result = await resolveInterest(mockSupabase([]), "camp-1", ["c1", "c2"]);

    expect(result.get("c1")).toEqual({ contactId: "c1", bucket: "no_click", artists: [] });
    expect(result.get("c2")?.bucket).toBe("no_click");
  });

  it("names up to three artists, ordered by when each was first clicked", async () => {
    const result = await resolveInterest(
      mockSupabase([
        click("c1", "RAKISH", ARTIST("rakish"), "2026-09-10T10:05:00Z"),
        click("c1", "SUMMER CAMARGO", ARTIST("summer-camargo"), "2026-09-10T10:01:00Z"),
        click("c1", "LILY HENLEY", ARTIST("lily-henley"), "2026-09-10T10:09:00Z"),
      ]),
      "camp-1",
      ["c1"],
    );

    expect(result.get("c1")).toEqual({
      contactId: "c1",
      bucket: "clicked_focused",
      artists: ["Summer Camargo", "Rakish", "Lily Henley"],
    });
  });

  it("uses each artist's FIRST click for ordering, not a later repeat", async () => {
    const result = await resolveInterest(
      mockSupabase([
        click("c1", "SUMMER CAMARGO", ARTIST("summer-camargo"), "2026-09-10T10:00:00Z"),
        click("c1", "RAKISH", ARTIST("rakish"), "2026-09-10T10:02:00Z"),
        // Coming back to Summer later must not push her behind Rakish.
        click("c1", "SUMMER CAMARGO", ARTIST("summer-camargo"), "2026-09-12T18:00:00Z"),
      ]),
      "camp-1",
      ["c1"],
    );

    expect(result.get("c1")?.artists).toEqual(["Summer Camargo", "Rakish"]);
  });

  it("names nobody once the contact has opened four or more", async () => {
    const rows = ["rakish", "summer-camargo", "lily-henley", "samir-langus"].map((slug, i) =>
      click("c1", slug.toUpperCase(), ARTIST(slug), `2026-09-10T10:0${i}:00Z`),
    );

    const result = await resolveInterest(mockSupabase(rows), "camp-1", ["c1"]);

    expect(result.get("c1")?.bucket).toBe("clicked_broad");
    expect(result.get("c1")?.artists).toEqual([]);
  });

  it("ignores the roster index and signature links, which are not artists", async () => {
    const result = await resolveInterest(
      mockSupabase([
        click("c1", "Full roster, videos, workshop offerings and more here", ROSTER_INDEX, "2026-09-10T10:00:00Z"),
        click("c1", "jaymestone.com", ROSTER_INDEX, "2026-09-10T10:01:00Z"),
        click("c1", "SUMMER CAMARGO", ARTIST("summer-camargo"), "2026-09-10T10:02:00Z"),
      ]),
      "camp-1",
      ["c1"],
    );

    expect(result.get("c1")).toMatchObject({ bucket: "clicked_focused", artists: ["Summer Camargo"] });
  });

  it("keeps contacts separate from each other", async () => {
    const result = await resolveInterest(
      mockSupabase([
        click("c1", "RAKISH", ARTIST("rakish"), "2026-09-10T10:00:00Z"),
        click("c2", "LILY HENLEY", ARTIST("lily-henley"), "2026-09-10T10:00:00Z"),
      ]),
      "camp-1",
      ["c1", "c2", "c3"],
    );

    expect(result.get("c1")?.artists).toEqual(["Rakish"]);
    expect(result.get("c2")?.artists).toEqual(["Lily Henley"]);
    expect(result.get("c3")?.bucket).toBe("no_click");
  });

  it("throws rather than silently reporting no_click when the lookup fails", async () => {
    // Swallowing this would send the "we never heard from you" note to
    // contacts who had engaged -- a wrong impression that cannot be undone,
    // in exchange for a transient error that retries in five minutes.
    await expect(resolveInterest(mockSupabase([], { message: "timeout" }), "camp-1", ["c1"])).rejects.toThrow(
      /timeout/,
    );
  });

  it("chunks the id list so a whole campaign does not blow the URL length", async () => {
    // PostgREST puts .in() lists in the query string; one request for
    // thousands of UUIDs fails as an opaque "fetch failed". Found by
    // running the preview over all 4,058 contacts of a real campaign.
    const ids = Array.from({ length: 450 }, (_, i) => `contact-${i}`);
    const supabase = mockSupabase([]);

    await resolveInterest(supabase, "camp-1", ids);

    const calls = (supabase as unknown as { __calls: string[][] }).__calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(200);
    expect(calls.flat()).toHaveLength(450);
  });

  it("still finds clicks for contacts in a later chunk", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `contact-${i}`);
    const supabase = mockSupabase([
      click("contact-240", "RAKISH", ARTIST("rakish"), "2026-09-10T10:00:00Z"),
    ]);

    const result = await resolveInterest(supabase, "camp-1", ids);

    expect(result.get("contact-240")).toMatchObject({ bucket: "clicked_focused", artists: ["Rakish"] });
    expect(result.get("contact-0")?.bucket).toBe("no_click");
  });

  it("makes no query at all when there are no contacts to resolve", async () => {
    const exploding = {
      from: () => {
        throw new Error("should not query");
      },
    } as never;

    await expect(resolveInterest(exploding, "camp-1", [])).resolves.toEqual(new Map());
  });
});
