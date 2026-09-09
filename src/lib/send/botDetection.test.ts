import { describe, expect, it } from "vitest";
import { detectLikelyBot, isSuspiciouslyFast, looksLikeBotUserAgent } from "./botDetection";

describe("looksLikeBotUserAgent", () => {
  it("flags known email-security scanner user-agents", () => {
    expect(looksLikeBotUserAgent("Microsoft Outlook SafeLinks")).toBe(true);
    expect(looksLikeBotUserAgent("ProofpointGoodSecurityScanner/1.0")).toBe(true);
    expect(looksLikeBotUserAgent("Mimecast-URL-Protect/2.1")).toBe(true);
  });

  it("doesn't flag an ordinary browser user-agent", () => {
    expect(looksLikeBotUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe(false);
  });
});

describe("isSuspiciouslyFast", () => {
  it("flags a click within the default 10s threshold of the token being minted", () => {
    const created = "2026-09-08T12:00:00.000Z";
    const clicked = new Date("2026-09-08T12:00:03.000Z");
    expect(isSuspiciouslyFast(created, clicked)).toBe(true);
  });

  it("doesn't flag a click well after the token was minted", () => {
    const created = "2026-09-08T12:00:00.000Z";
    const clicked = new Date("2026-09-08T14:30:00.000Z");
    expect(isSuspiciouslyFast(created, clicked)).toBe(false);
  });
});

describe("detectLikelyBot", () => {
  it("flags a fast click even with a normal-looking user-agent", () => {
    const created = "2026-09-08T12:00:00.000Z";
    const clicked = new Date("2026-09-08T12:00:01.000Z");
    expect(detectLikelyBot("Mozilla/5.0", created, clicked)).toBe(true);
  });

  it("flags a scanner user-agent even on a slow click", () => {
    const created = "2026-09-08T12:00:00.000Z";
    const clicked = new Date("2026-09-08T15:00:00.000Z");
    expect(detectLikelyBot("Microsoft Outlook SafeLinks", created, clicked)).toBe(true);
  });

  it("doesn't flag a plausible real human click", () => {
    const created = "2026-09-08T12:00:00.000Z";
    const clicked = new Date("2026-09-08T14:12:00.000Z");
    expect(detectLikelyBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", created, clicked)).toBe(false);
  });
});
