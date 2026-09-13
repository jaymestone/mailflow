import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatFromAddress, getAccessToken } from "./client";

vi.mock("@/lib/oauth/google", () => ({
  refreshAccessToken: vi.fn(async () => ({
    access_token: "fake-access-token",
    expires_in: 3600,
    scope: "x",
    token_type: "Bearer",
  })),
}));

function fakeSupabase(rpcResults: Array<{ data: string | null; error: { message: string } | null }>): SupabaseClient {
  let call = 0;
  return {
    rpc: vi.fn(async () => rpcResults[Math.min(call++, rpcResults.length - 1)]),
  } as unknown as SupabaseClient;
}

describe("formatFromAddress", () => {
  it("formats a display name and email as a quoted address", () => {
    expect(formatFromAddress("Jayme Stone", "j@jaymestoneagency.com")).toBe(
      '"Jayme Stone" <j@jaymestoneagency.com>',
    );
  });

  it("falls back to a bare email when there is no display name", () => {
    expect(formatFromAddress(null, "j@jaymestoneagency.com")).toBe("j@jaymestoneagency.com");
  });

  it("falls back to a bare email when the display name is blank", () => {
    expect(formatFromAddress("   ", "j@jaymestoneagency.com")).toBe("j@jaymestoneagency.com");
  });

  it("escapes an embedded double quote in the display name", () => {
    expect(formatFromAddress('Jayme "The Agent" Stone', "j@x.com")).toBe(
      '"Jayme \\"The Agent\\" Stone" <j@x.com>',
    );
  });
});

describe("getAccessToken", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("succeeds on the first try when the refresh token read succeeds immediately", async () => {
    const supabase = fakeSupabase([{ data: "refresh-token-1", error: null }]);
    await expect(getAccessToken(supabase, "acct-1")).resolves.toBe("fake-access-token");
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("retries past a transient read failure (error, then null data) before succeeding", async () => {
    const supabase = fakeSupabase([
      { data: null, error: { message: "connection reset" } },
      { data: null, error: null },
      { data: "refresh-token-1", error: null },
    ]);
    await expect(getAccessToken(supabase, "acct-1")).resolves.toBe("fake-access-token");
    expect(supabase.rpc).toHaveBeenCalledTimes(3);
  });

  it("throws 'No refresh token stored' only after every retry is exhausted", async () => {
    const supabase = fakeSupabase([{ data: null, error: { message: "still broken" } }]);
    await expect(getAccessToken(supabase, "acct-1")).rejects.toThrow("No refresh token stored for this account");
    expect(supabase.rpc).toHaveBeenCalledTimes(3);
  });
});
