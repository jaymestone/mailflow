import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/gmail/client", () => ({ getAccessToken: async () => "tok" }));
import { sendDrafts } from "./actions";

const supabase: any = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "a" } }) }) }) }) };
const body = (t: string) => ({ message: { payload: { mimeType: "text/plain", body: { data: Buffer.from(t).toString("base64url") } } } });

describe("sendDrafts with an approval line", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("never sends a draft it couldn't read (rate limit)", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      if (init?.method === "POST") { sent.push(JSON.parse(init.body).id); return new Response("{}", { status: 200 }); }
      return new Response(JSON.stringify({ error: { code: 403 } }), { status: 403 });
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    const out = await sendDrafts(supabase, "x@y", ["d1"], "DELETE THIS LINE");
    vi.useRealTimers();
    expect(sent).toEqual([]);
    expect(out.failed[0]).toMatch(/not sent/);
  }, 30000);
  it("sends only drafts whose line is gone", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: any) => {
      if (init?.method === "POST") { sent.push(JSON.parse(init.body).id); return new Response("{}", { status: 200 }); }
      return new Response(JSON.stringify(url.includes("/d1?") ? body("Hi Joe") : body("▶ DELETE THIS LINE TO APPROVE\n\nHi")), { status: 200 });
    });
    const out = await sendDrafts(supabase, "x@y", ["d1", "d2"], "DELETE THIS LINE");
    expect(sent).toEqual(["d1"]);
    expect(out.notApproved).toBe(1);
  }, 30000);
  it("stops at the deadline and reports partial", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const out = await sendDrafts(supabase, "x@y", ["d1", "d2"], "DELETE THIS LINE", 0);
    expect(out.partial).toBe(true);
    expect(out.sent).toBe(0);
    expect(out.remaining).toEqual(["d1", "d2"]);
  });
});
