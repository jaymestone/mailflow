import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "@/lib/gmail/client";
import { fetchGmailMessage } from "@/lib/gmail/messages";
import { classifyBounce } from "./bounceDetection";
import { processOneMessage, type ReplyTickResult } from "./tick";

const CATEGORY_LABELS = ["Interested", "Not Interested", "Follow Up", "Out of Office", "Departed", "Opted Out", "Bounce", "Unclear"];

const DEFAULT_WINDOW_DAYS = 3;
const MAX_WINDOW_DAYS = 14;

// Confirmed live, 2026-09-16: a real run against a high-volume account
// (stone@jaymestone.com, hundreds of bounces in-window) processed bounces
// first, exactly as originally designed here -- and that alone consumed
// the entire request before a single genuine reply (where every one of
// that day's actually-important stuck messages lived) ever got a turn.
// The function almost certainly hit Vercel's hard maxDuration kill with no
// graceful stop, no partial-truncation signal, nothing -- just silence.
// Two changes: replies now run BEFORE bounces (they're rare and valuable;
// bounces are numerous and low-stakes, so doing replies first means they
// almost always finish regardless of bounce volume), and both loops watch
// a soft internal deadline so a real timeout produces a clean, reported
// truncation instead of being silently killed mid-request.
const DEFAULT_SOFT_DEADLINE_MS = 240_000; // leaves ~60s headroom under the 300s admin route

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gmail's per-minute-per-user quota is easy to burst through with a tight
// sequential loop of get-message calls (confirmed live, 2026-09-16: a plain
// loop with no pacing hit a 403 rateLimitExceeded partway through discovery
// on the very first account). A small fixed delay between calls, plus a
// retry with backoff on the specific rate-limit error, keeps this well
// under the limit without needing real concurrency control.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("rateLimitExceeded") && !message.includes("RESOURCE_EXHAUSTED")) throw err;
      await sleep(5000 * (attempt + 1));
    }
  }
  return fn();
}

function freshTickResult(): ReplyTickResult {
  return {
    accountsPolled: 0,
    messagesFetched: 0,
    bounces: 0,
    softBounces: 0,
    replies: 0,
    suppressed: 0,
    pausedElsewhere: 0,
    removedForReplacement: 0,
    errors: [],
    historyResets: [],
  };
}

type Candidate = { account: { id: string; email_address: string }; gmailMessageId: string };

export type ReprocessResult = {
  windowDays: number;
  dryRun: boolean;
  bounceCandidateCount: number;
  replyCandidateCount: number;
  /** True when maxMessages cut the batch short -- more candidates were
   * found than were actually processed this call. A real, non-dryRun
   * truncation is itself worth surfacing: the daily safety-net cron is
   * sized for catching rare stragglers, and finding more than that in one
   * pass means something is actively wrong again, not just a normal
   * trickle. */
  truncated: boolean;
  bounceResult: ReplyTickResult;
  replyResult: ReplyTickResult;
  errors: { account: string; gmailMessageId: string; error: string }[];
};

/** Finds every inbox message (within `windowDays`) that has no Mailflow
 * category label -- the clean signature of "never touched by the reply
 * pipeline," the failure mode behind the 2026-09-16 checkpoint-skip
 * incident -- and, unless dryRun, runs each one through the real
 * processOneMessage pipeline (classify, match, insert, suppress/pause/
 * label), exactly as a normal tick would have.
 *
 * Runs genuine replies/auto-replies first, then bounces -- the reverse of
 * the tick's own cheap-before-expensive priority, deliberately: replies
 * are rare and are the actual reason a human is running this, while
 * bounces are numerous, low-stakes housekeeping that can (and did, live,
 * 2026-09-16) consume an entire run's time budget by volume alone if they
 * go first, starving every genuine reply out of the run. Both passes, and
 * discovery itself, respect an internal soft time deadline (see
 * DEFAULT_SOFT_DEADLINE_MS) so a real timeout produces a clean, reported
 * truncation instead of running until the platform kills the request.
 *
 * This is the library form of what was, on 2026-09-16, a hand-written
 * one-off script (scripts/recover-backlog.ts) -- built into the app so
 * recovering from this failure mode never again requires writing new code
 * under time pressure. Also used, unattended, by the daily
 * cron/reprocess-backlog safety net. */
export async function reprocessStuckMessages(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean; windowDays?: number; maxMessages?: number; softDeadlineMs?: number } = {},
): Promise<ReprocessResult> {
  const dryRun = opts.dryRun ?? false;
  const windowDays = Math.min(Math.max(opts.windowDays ?? DEFAULT_WINDOW_DAYS, 1), MAX_WINDOW_DAYS);
  const maxMessages = opts.maxMessages ?? Number.POSITIVE_INFINITY;
  const softDeadlineMs = opts.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS;
  const startedAt = Date.now();
  const timeIsUp = () => Date.now() - startedAt > softDeadlineMs;

  const { data: accounts, error } = await supabase.from("connected_accounts").select("id, email_address").eq("status", "active");
  if (error) throw error;

  const excludeClause = CATEGORY_LABELS.map((l) => `-label:"${l}"`).join(" ");
  const q = `in:inbox ${excludeClause} -in:sent -in:chats newer_than:${windowDays}d`;

  const bounceCandidates: Candidate[] = [];
  const replyCandidates: Candidate[] = [];
  const errors: ReprocessResult["errors"] = [];

  const tokenCache = new Map<string, string>();
  async function tokenFor(accountId: string): Promise<string> {
    const cached = tokenCache.get(accountId);
    if (cached) return cached;
    const token = await getAccessToken(supabase, accountId);
    tokenCache.set(accountId, token);
    return token;
  }

  let discoveryTruncated = false;
  discoveryLoop: for (const account of accounts ?? []) {
    const accessToken = await tokenFor(account.id);
    let pageToken: string | undefined;
    const ids: string[] = [];
    do {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      url.searchParams.set("q", q);
      url.searchParams.set("maxResults", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = (await res.json()) as { messages?: { id: string }[]; nextPageToken?: string };
      ids.push(...(data.messages ?? []).map((m) => m.id));
      pageToken = data.nextPageToken;
    } while (pageToken && ids.length < 1000);

    for (const id of ids) {
      if (timeIsUp()) {
        discoveryTruncated = true;
        break discoveryLoop;
      }
      try {
        // Read-only routing check -- SENT copies and already-recorded
        // messages are re-checked for real (and safely skipped) inside
        // processOneMessage itself; this fetch only decides which pass a
        // genuinely new message belongs in.
        const email = await withRetry(() => fetchGmailMessage(accessToken, id));
        await sleep(150);
        if (email.labelIds.includes("SENT")) continue;
        const bounceInfo = classifyBounce(email);
        const bucket = bounceInfo.isBounce ? bounceCandidates : replyCandidates;
        bucket.push({ account, gmailMessageId: id });
      } catch (err) {
        errors.push({ account: account.email_address, gmailMessageId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const bounceResult = freshTickResult();
  const replyResult = freshTickResult();

  const totalCandidates = bounceCandidates.length + replyCandidates.length;
  const capTruncated = totalCandidates > maxMessages;
  let deadlineTruncated = discoveryTruncated;

  // Replies first, bounces second -- the reverse of the automated tick's
  // own cheap-before-expensive priority, deliberately: genuine replies are
  // rare and are the actual reason a human clicked this button, while
  // bounces are numerous, low-stakes housekeeping. Putting replies first
  // means they almost always finish inside the time budget regardless of
  // how much bounce volume is waiting behind them, instead of bounce
  // volume alone being able to starve every genuine reply out of a run
  // entirely (confirmed live, 2026-09-16 -- see the comment on
  // DEFAULT_SOFT_DEADLINE_MS above).
  const boundedReplies = replyCandidates.slice(0, maxMessages);
  const remainingForBounces = Math.max(maxMessages - boundedReplies.length, 0);
  const boundedBounces = bounceCandidates.slice(0, remainingForBounces);

  if (!dryRun) {
    const replyLabelCache = new Map<string, string>();
    const replyBudget = { cheap: Number.MAX_SAFE_INTEGER, expensive: Number.MAX_SAFE_INTEGER };
    for (const c of boundedReplies) {
      if (timeIsUp()) {
        deadlineTruncated = true;
        break;
      }
      try {
        const accessToken = await tokenFor(c.account.id);
        await withRetry(() => processOneMessage(supabase, c.account, c.gmailMessageId, accessToken, replyLabelCache, replyResult, replyBudget));
        await sleep(150);
      } catch (err) {
        errors.push({ account: c.account.email_address, gmailMessageId: c.gmailMessageId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const bounceLabelCache = new Map<string, string>();
    const bounceBudget = { cheap: Number.MAX_SAFE_INTEGER, expensive: Number.MAX_SAFE_INTEGER };
    for (const c of boundedBounces) {
      if (timeIsUp()) {
        deadlineTruncated = true;
        break;
      }
      try {
        const accessToken = await tokenFor(c.account.id);
        await withRetry(() => processOneMessage(supabase, c.account, c.gmailMessageId, accessToken, bounceLabelCache, bounceResult, bounceBudget));
        await sleep(150);
      } catch (err) {
        errors.push({ account: c.account.email_address, gmailMessageId: c.gmailMessageId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    windowDays,
    dryRun,
    bounceCandidateCount: bounceCandidates.length,
    replyCandidateCount: replyCandidates.length,
    truncated: capTruncated || deadlineTruncated,
    bounceResult,
    replyResult,
    errors,
  };
}
