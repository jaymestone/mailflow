import { describe, expect, it } from "vitest";
import { rewriteLinksForTracking } from "./clickTracking";

const BASE = "https://mailflow-five-fawn.vercel.app";

describe("rewriteLinksForTracking", () => {
  it("returns the body unchanged with no tokens when there are no links", () => {
    const result = rewriteLinksForTracking("Hi there, no links in this one.", BASE);
    expect(result.body).toBe("Hi there, no links in this one.");
    expect(result.tokens).toEqual([]);
  });

  it("rewrites a single link and records its label and destination", () => {
    const result = rewriteLinksForTracking("[RAKISH](https://www.jaymestone.com/agency/rakish) — Celtic music", BASE);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].label).toBe("RAKISH");
    expect(result.tokens[0].destination_url).toBe("https://www.jaymestone.com/agency/rakish");
    expect(result.body).toBe(`[RAKISH](${BASE}/api/r/${result.tokens[0].token}) — Celtic music`);
  });

  it("gives each link its own token even when label and URL are identical", () => {
    const body = "[jaymestone.com](https://www.jaymestone.com/agency) and again [jaymestone.com](https://www.jaymestone.com/agency)";
    const result = rewriteLinksForTracking(body, BASE);
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0].token).not.toBe(result.tokens[1].token);
    // Both occurrences got rewritten -- neither is left pointing at the real URL.
    expect(result.body).not.toContain("https://www.jaymestone.com/agency)");
  });

  it("rewrites multiple distinct links and leaves surrounding text untouched", () => {
    const body =
      "[THE LITTLE MERCIES](https://www.jaymestone.com/agency/the-little-mercies) — old-time\n" +
      "[RAKISH](https://www.jaymestone.com/agency/rakish) — Celtic";
    const result = rewriteLinksForTracking(body, BASE);
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens.map((t) => t.label)).toEqual(["THE LITTLE MERCIES", "RAKISH"]);
    expect(result.body).toContain(" — old-time\n");
    expect(result.body).toContain(" — Celtic");
    expect(result.body).toMatch(new RegExp(`^\\[THE LITTLE MERCIES\\]\\(${BASE}/api/r/[\\w-]+\\) — old-time`));
  });

  it("never mints two identical tokens across separate calls", () => {
    const a = rewriteLinksForTracking("[X](https://example.com/a)", BASE);
    const b = rewriteLinksForTracking("[X](https://example.com/a)", BASE);
    expect(a.tokens[0].token).not.toBe(b.tokens[0].token);
  });
});
