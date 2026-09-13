import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthTokenRevokedError, refreshAccessToken } from "./google";

function mockFetchOnce(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    }),
  );
}

describe("refreshAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws OAuthTokenRevokedError when Google reports invalid_grant", async () => {
    mockFetchOnce(400, JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired" }));
    await expect(refreshAccessToken("dead-token")).rejects.toThrow(OAuthTokenRevokedError);
  });

  it("throws a plain Error (not OAuthTokenRevokedError) for a transient 5xx", async () => {
    mockFetchOnce(503, "Service Unavailable");
    const promise = refreshAccessToken("some-token");
    await expect(promise).rejects.toThrow(/Token refresh failed: 503/);
    await expect(promise).rejects.not.toBeInstanceOf(OAuthTokenRevokedError);
  });

  it("throws a plain Error for a non-JSON error body", async () => {
    mockFetchOnce(500, "<html>gateway error</html>");
    const promise = refreshAccessToken("some-token");
    await expect(promise).rejects.toThrow(/Token refresh failed: 500/);
    await expect(promise).rejects.not.toBeInstanceOf(OAuthTokenRevokedError);
  });

  it("returns the parsed token response on success", async () => {
    mockFetchOnce(200, JSON.stringify({ access_token: "abc", expires_in: 3600, scope: "x", token_type: "Bearer" }));
    await expect(refreshAccessToken("good-token")).resolves.toMatchObject({ access_token: "abc" });
  });
});
