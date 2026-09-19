import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndSendAlerts } from "./alerts";

vi.mock("@/lib/oauth/google", () => ({ OAuthTokenRevokedError: class OAuthTokenRevokedError extends Error {} }));
vi.mock("@/lib/gmail/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gmail/client")>("@/lib/gmail/client");
  return { ...actual, getAccessToken: vi.fn(async () => "fake-token"), sendGmailMessage: vi.fn(async () => ({ id: "sent-1", threadId: "thread-1" })) };
});

/** Returns a chainable, thenable query-builder stub -- every intermediate
 * method (select/eq/in/not/is/lt/gte) returns itself so any call sequence
 * works, and it resolves (directly, or via maybeSingle/upsert) to whatever
 * result this specific call was configured with. */
function stub(result: { data?: unknown; count?: number } = {}) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    is: () => builder,
    lt: () => builder,
    gte: () => builder,
    limit: () => builder,
    upsert: async () => ({ data: null, error: null }),
    maybeSingle: async () => ({ data: result.data ?? null, error: null }),
    then: (resolve: (v: { data: unknown; error: null; count?: number }) => void) =>
      resolve({ data: result.data ?? null, error: null, count: result.count }),
  };
  return builder;
}

/** Some tables are queried more than once per run, with different shapes
 * each time -- this returns each queued stub in the exact order
 * checkAndSendAlerts issues those calls, holding on the last one for any
 * further calls beyond what was queued (covers the repeated per-signal
 * app_settings upsert, whose generic stub().upsert already no-ops fine
 * regardless of which stub instance answers it). */
function sequenced(...results: ReturnType<typeof stub>[]) {
  let i = 0;
  return () => results[Math.min(i++, results.length - 1)];
}

const HEALTHY_CRON = [
  { job_name: "geocode-tick", last_run_at: new Date().toISOString(), last_result: {} },
  { job_name: "send-engine-tick", last_run_at: new Date().toISOString(), last_result: {} },
  { job_name: "reply-poll-tick", last_run_at: new Date().toISOString(), last_result: {} },
];

const DEFAULT_ACCOUNT_ID = "862e145b-333c-4845-b943-a113eaf82940";

type Overrides = Partial<{
  cronHealth: unknown[];
  errorAccounts: unknown[];
  unlabeledCount: number;
  /** Senders of unmatched replies/bounces in the window. */
  unmatchedSenders: { from_email: string }[];
  /** Emails from `unmatchedSenders` that resolve to a contact who is still
   * active in a campaign -- the only case that now alerts. */
  activeContactEmails: string[];
  failureCount: number;
  cooldownRows: unknown[];
  accountId: string | null;
  upserts: unknown[];
}>;

/** checkAndSendAlerts' own call order per table (see alerts.ts):
 * inbound_messages -> [unlabeled-backlog count, then the unmatched-sender
 * list]; contacts/campaign_members -> one lookup pair per distinct sender;
 * connected_accounts -> [error-account list, then (only if something is
 * due) the sending account by id]; app_settings -> [cooldown-rows lookup,
 * then (only if something is due) reply_to_account_id, then one upsert per
 * due signal]. */
function baseSupabase(overrides: Overrides = {}) {
  const activeSet = new Set((overrides.activeContactEmails ?? []).map((e) => e.toLowerCase()));
  const inboundSequence = sequenced(
    stub({ count: overrides.unlabeledCount ?? 0 }),
    stub({ data: overrides.unmatchedSenders ?? [] }),
  );
  // contacts is queried as .select("id").ilike("email", <sender>).maybeSingle();
  // a sender only counts as a real contact when it's in activeContactEmails.
  const contactsStub = {
    select: () => ({
      ilike: (_col: string, val: string) => ({
        maybeSingle: async () => ({ data: activeSet.has(val.toLowerCase()) ? { id: `contact-${val}` } : null, error: null }),
      }),
    }),
  };
  const campaignMembersStub = {
    select: () => ({
      eq: () => ({
        eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: "cm-1" }, error: null }) }) }),
      }),
    }),
  };
  const connectedAccountsSequence = sequenced(
    stub({ data: overrides.errorAccounts ?? [] }),
    stub({ data: { id: DEFAULT_ACCOUNT_ID, email_address: "stone@jaymestone.com", display_name: "Jayme Stone" } }),
  );
  const accountIdValue = overrides.accountId === undefined ? DEFAULT_ACCOUNT_ID : overrides.accountId;
  const upsertStub = stub();
  upsertStub.upsert = async (row: unknown) => {
    overrides.upserts?.push(row);
    return { data: null, error: null };
  };
  const appSettingsSequence = sequenced(
    stub({ data: overrides.cooldownRows ?? [] }),
    stub({ data: accountIdValue === null ? null : { value: accountIdValue } }),
    upsertStub,
  );

  return {
    from: (table: string) => {
      switch (table) {
        case "cron_health":
          return stub({ data: overrides.cronHealth ?? HEALTHY_CRON });
        case "connected_accounts":
          return connectedAccountsSequence();
        case "inbound_messages":
          return inboundSequence();
        case "contacts":
          return contactsStub;
        case "campaign_members":
          return campaignMembersStub;
        case "outbound_sends":
          return stub({ count: overrides.failureCount ?? 0 });
        case "app_settings":
          return appSettingsSequence();
        default:
          return stub();
      }
    },
  } as unknown as SupabaseClient;
}

describe("checkAndSendAlerts", () => {
  it("sends nothing when every signal is healthy", async () => {
    const { sendGmailMessage } = await import("@/lib/gmail/client");
    vi.mocked(sendGmailMessage).mockClear();

    const result = await checkAndSendAlerts(baseSupabase());

    expect(result).toEqual({ unhealthySignals: [], sentEmail: false, skippedByCooldown: [] });
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("emails one summary when a cron job has gone stale, and records a cooldown for it", async () => {
    const { sendGmailMessage } = await import("@/lib/gmail/client");
    vi.mocked(sendGmailMessage).mockClear();

    const staleCron = [
      { job_name: "geocode-tick", last_run_at: new Date(Date.now() - 30 * 60_000).toISOString(), last_result: {} }, // 30m ago, expected every 1m
      { job_name: "send-engine-tick", last_run_at: new Date().toISOString(), last_result: {} },
      { job_name: "reply-poll-tick", last_run_at: new Date().toISOString(), last_result: {} },
    ];
    const upserts: unknown[] = [];
    const supabase = baseSupabase({ cronHealth: staleCron, upserts });

    const result = await checkAndSendAlerts(supabase);

    expect(result.sentEmail).toBe(true);
    expect(result.unhealthySignals).toContain("stale-cron:geocode-tick");
    expect(sendGmailMessage).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(sendGmailMessage).mock.calls[0];
    expect(opts.to).toBe("jayme@jaymestone.com");
    expect(opts.body).toContain("geocode-tick");
    expect(upserts).toEqual([{ key: "alert_cooldown:stale-cron:geocode-tick", value: expect.any(String) }]);
  });

  it("does not re-email a signal that's still within its cooldown window", async () => {
    const { sendGmailMessage } = await import("@/lib/gmail/client");
    vi.mocked(sendGmailMessage).mockClear();

    const staleCron = [
      { job_name: "geocode-tick", last_run_at: new Date(Date.now() - 30 * 60_000).toISOString(), last_result: {} },
      { job_name: "send-engine-tick", last_run_at: new Date().toISOString(), last_result: {} },
      { job_name: "reply-poll-tick", last_run_at: new Date().toISOString(), last_result: {} },
    ];
    // Cooldown recorded 1 hour ago -- well inside the 4h window.
    const recentCooldown = [{ key: "alert_cooldown:stale-cron:geocode-tick", value: new Date(Date.now() - 60 * 60_000).toISOString() }];
    const supabase = baseSupabase({ cronHealth: staleCron, cooldownRows: recentCooldown });

    const result = await checkAndSendAlerts(supabase);

    expect(result.sentEmail).toBe(false);
    expect(result.unhealthySignals).toContain("stale-cron:geocode-tick");
    expect(result.skippedByCooldown).toContain("stale-cron:geocode-tick");
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("detects an unlabeled backlog and an account error together in one email", async () => {
    const { sendGmailMessage } = await import("@/lib/gmail/client");
    vi.mocked(sendGmailMessage).mockClear();

    const supabase = baseSupabase({
      unlabeledCount: 12,
      errorAccounts: [{ email_address: "agency@jaymestone.com", last_error: "invalid_grant" }],
    });

    const result = await checkAndSendAlerts(supabase);

    expect(result.sentEmail).toBe(true);
    expect(result.unhealthySignals).toEqual(expect.arrayContaining(["unlabeled-backlog", "account-error:agency@jaymestone.com"]));
    expect(sendGmailMessage).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(sendGmailMessage).mock.calls[0];
    expect(opts.body).toContain("12 message(s)");
    expect(opts.body).toContain("agency@jaymestone.com");
    expect(opts.subject).toContain("2 issues");
  });

  // The original version of this signal counted raw unmatched messages and
  // fired constantly on nothing actionable (confirmed live, 2026-09-19: 91
  // unmatched in 24h, zero of them a contact still being sequenced --
  // several alert emails a day, all noise). These two pin down the
  // narrowed behavior: silent on ordinary unmatched volume, loud only when
  // someone will actually keep getting emailed past their own reply.
  it("stays silent on unmatched messages whose senders aren't active contacts, however many there are", async () => {
    const { sendGmailMessage } = await import("@/lib/gmail/client");
    vi.mocked(sendGmailMessage).mockClear();

    const manySenders = Array.from({ length: 91 }, (_, i) => ({ from_email: `stranger${i}@example.com` }));
    const supabase = baseSupabase({ unmatchedSenders: manySenders, activeContactEmails: [] });

    const result = await checkAndSendAlerts(supabase);

    expect(result.unhealthySignals).toEqual([]);
    expect(result.sentEmail).toBe(false);
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("alerts on even a single unmatched sender who is still active in a campaign, naming them", async () => {
    const { sendGmailMessage } = await import("@/lib/gmail/client");
    vi.mocked(sendGmailMessage).mockClear();

    const supabase = baseSupabase({
      unmatchedSenders: [
        { from_email: "stranger@example.com" },
        { from_email: "booker@realvenue.org" },
      ],
      activeContactEmails: ["booker@realvenue.org"],
    });

    const result = await checkAndSendAlerts(supabase);

    expect(result.unhealthySignals).toEqual(["unmatched-active-contact"]);
    expect(result.sentEmail).toBe(true);
    const [, opts] = vi.mocked(sendGmailMessage).mock.calls[0];
    expect(opts.body).toContain("booker@realvenue.org");
    expect(opts.body).toContain("STILL ACTIVE");
    expect(opts.body).not.toContain("stranger@example.com");
  });
});
