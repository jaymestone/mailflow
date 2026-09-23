import { describe, it, expect } from "vitest";
import { classifyClicks, rankClickedArtists, type RawClick } from "./classify";

const SENT = "2026-09-01T12:00:00.000Z";
const sentMs = new Date(SENT).getTime();

/** A click `afterSeconds` after the send, on `label`. */
function click(label: string, afterSeconds: number, userAgent: string | null = "Mozilla/5.0 (Macintosh)"): RawClick {
  return {
    id: `click-${label}-${afterSeconds}`,
    token: `${label}-${afterSeconds}`,
    label,
    clickedAt: new Date(sentMs + afterSeconds * 1000).toISOString(),
    tokenCreatedAt: SENT,
    userAgent,
  };
}

const ROSTER = ["SUMMER CAMARGO", "RAKISH", "LILY HENLEY", "SAMIR LANGUS", "AMANDA PASCALI", "THE LITTLE MERCIES", "KAVITA SHAH", "SAM REIDER & THE HUMAN HANDS"];

describe("classifyClicks", () => {
  it("flags the measured scanner signature: many links in one burst, seconds after send", () => {
    // The dominant production pattern -- 1,584 contacts hit 8+ artist
    // links with a median span of 4.9s, starting ~60s after send.
    const clicks = ROSTER.map((label, i) => click(label, 60 + i));

    const result = classifyClicks(clicks);

    expect(result.every((c) => c.clickClass === "scanner")).toBe(true);
    expect(result[0].reason).toMatch(/different links hit within/);
  });

  it("keeps a single real click made minutes after the send", () => {
    const result = classifyClicks([click("SUMMER CAMARGO", 6 * 60)]);

    expect(result[0].clickClass).toBe("human");
  });

  it("keeps two artists browsed at reading pace", () => {
    // Measured shape of a genuine 2-artist clicker: ~6 min after send,
    // the two clicks ~41s apart.
    const result = classifyClicks([click("SUMMER CAMARGO", 6 * 60), click("RAKISH", 6 * 60 + 41)]);

    expect(result.map((c) => c.clickClass)).toEqual(["human", "human"]);
  });

  it("keeps three artists browsed over several minutes", () => {
    // Real 3-artist clickers spread over ~4 minutes -- must NOT trip the
    // burst rule, which is why its window is 120s and not longer.
    const result = classifyClicks([
      click("SUMMER CAMARGO", 12 * 60),
      click("RAKISH", 14 * 60),
      click("LILY HENLEY", 16 * 60),
    ]);

    expect(result.map((c) => c.clickClass)).toEqual(["human", "human", "human"]);
  });

  it("flags a scanner that identifies itself even when the timing looks human", () => {
    const result = classifyClicks([click("RAKISH", 30 * 60, "Mozilla/5.0 ... SafeLinks")]);

    expect(result[0].clickClass).toBe("scanner");
    expect(result[0].reason).toMatch(/user-agent/);
  });

  it("rescues a genuine later click from a contact whose mail was also scanned", () => {
    // The case that makes per-click (rather than per-contact) classification
    // worth the complexity: this venue really did come back and look.
    const scanned = ROSTER.map((label, i) => click(label, 45 + i));
    const real = click("SUMMER CAMARGO", 3 * 24 * 3600);

    const result = classifyClicks([...scanned, real]);

    const realResult = result.find((c) => c.id === real.id);
    expect(realResult?.clickClass).toBe("human");
    expect(result.filter((c) => c.clickClass === "scanner")).toHaveLength(ROSTER.length);
  });

  it("catches a repeat scan days later the same way as the first one", () => {
    const first = ROSTER.map((label, i) => click(label, 50 + i));
    const rescan = ROSTER.map((label, i) => click(label, 4 * 24 * 3600 + i));

    const result = classifyClicks([...first, ...rescan]);

    expect(result.every((c) => c.clickClass === "scanner")).toBe(true);
  });

  it("flags a two-link scanner that returns day after day", () => {
    // Validating against production surfaced this: pairs of different
    // artists hit 0.2s apart, repeating for a fortnight. Too few links for
    // the burst rule and too late after send for the delay rule, so it
    // read as a contact who had genuinely opened nine artists.
    const visits: RawClick[] = [];
    for (let day = 1; day <= ROSTER.length / 2; day++) {
      const base = day * 24 * 3600;
      visits.push(click(ROSTER[day * 2 - 2], base));
      visits.push({ ...click(ROSTER[day * 2 - 1], base), clickedAt: new Date(sentMs + (base + 0.2) * 1000).toISOString() });
    }

    const result = classifyClicks(visits);

    expect(result.every((c) => c.clickClass === "scanner")).toBe(true);
    expect(result[0].reason).toMatch(/faster than a person can click/);
  });

  it("still keeps two artists opened seconds apart at human pace", () => {
    // The boundary the rule above must not cross: 8 seconds apart is slow
    // enough to be a person opening a second artist.
    const result = classifyClicks([click("SUMMER CAMARGO", 10 * 60), click("RAKISH", 10 * 60 + 8)]);

    expect(result.map((c) => c.clickClass)).toEqual(["human", "human"]);
  });

  it("calls a lone too-fast click uncertain rather than condemning it", () => {
    const result = classifyClicks([click("RAKISH", 20)]);

    expect(result[0].clickClass).toBe("uncertain");
  });

  it("returns nothing for a contact with no clicks", () => {
    expect(classifyClicks([])).toEqual([]);
  });
});

describe("rankClickedArtists", () => {
  it("orders by first click and caps at the requested limit", () => {
    const clicks = [
      click("RAKISH", 10 * 60),
      click("SUMMER CAMARGO", 12 * 60),
      click("LILY HENLEY", 20 * 60),
      click("SAMIR LANGUS", 30 * 60),
    ];

    const ranked = rankClickedArtists(classifyClicks(clicks), clicks, { limit: 3 });

    expect(ranked.map((r) => r.label)).toEqual(["RAKISH", "SUMMER CAMARGO", "LILY HENLEY"]);
  });

  it("counts repeat clicks on the same artist without duplicating it", () => {
    const clicks = [
      click("SUMMER CAMARGO", 10 * 60),
      { ...click("SUMMER CAMARGO", 25 * 60), id: "summer-again" },
      click("RAKISH", 40 * 60),
    ];

    const ranked = rankClickedArtists(classifyClicks(clicks), clicks);

    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({ label: "SUMMER CAMARGO", clicks: 2 });
    expect(ranked[0].firstClickedAt).toBe(clicks[0].clickedAt);
  });

  it("excludes scanner clicks entirely, so a scanned contact ranks nothing", () => {
    const clicks = ROSTER.map((label, i) => click(label, 60 + i));

    expect(rankClickedArtists(classifyClicks(clicks), clicks)).toEqual([]);
  });

  it("ignores non-artist links like the roster page when an artist set is given", () => {
    const clicks = [
      click("Full roster, videos, workshop offerings and more here", 10 * 60),
      click("SUMMER CAMARGO", 12 * 60),
    ];

    const ranked = rankClickedArtists(classifyClicks(clicks), clicks, { artistLabels: new Set(ROSTER) });

    expect(ranked.map((r) => r.label)).toEqual(["SUMMER CAMARGO"]);
  });
});
