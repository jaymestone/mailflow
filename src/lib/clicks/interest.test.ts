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

/** Minimal stand-in for the one chained query resolveInterest makes. */
function mockSupabase(rows: unknown[], error: { message: string } | null = null) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => Promise.resolve({ data: rows, error }),
  };
  return { from: () => builder } as never;
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

  it("makes no query at all when there are no contacts to resolve", async () => {
    const exploding = {
      from: () => {
        throw new Error("should not query");
      },
    } as never;

    await expect(resolveInterest(exploding, "camp-1", [])).resolves.toEqual(new Map());
  });
});
