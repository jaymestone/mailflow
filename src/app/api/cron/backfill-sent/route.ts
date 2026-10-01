import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAccessToken } from "@/lib/gmail/client";
import { fetchGmailMessage } from "@/lib/gmail/messages";
import { recordManualSend } from "@/lib/reply/recordManualSend";

export const maxDuration = 60;

/** One-off backfill of Jayme's historical sent mail into manual_sends.
 *
 * Going forward the reply tick records his replies as it sees them, but
 * everything he sent before that shipped is invisible, and without it the
 * board claims all 307 live conversations are waiting on him -- the exact
 * wrong answer, and the complaint that started this.
 *
 * It cannot come through the normal path: Gmail's history API only
 * retains about a week, so the backlog has to be reached by searching the
 * Sent folder directly.
 *
 * Resumable by design. One call does a bounded chunk and hands back a
 * page token; the caller loops. A long single pass would be killed by
 * Vercel's function ceiling partway through with no record of how far it
 * got -- the failure mode that has bitten batch scripts in this project
 * before.
 */

/** Leaves headroom inside maxDuration for the final writes. */
const DEADLINE_MS = 45_000;

/** Gmail bills per-user quota in units per second, not requests: a
 * messages.get costs 5, against a 250/second ceiling. Firing a page of
 * 100 gets as fast as the network allows blows straight through it and
 * every one comes back 429 -- the first run of this backfill scanned 100
 * messages and recorded none for exactly that reason. ~70ms between gets
 * holds it near 70 units/second, well under, and a page still clears in
 * about seven seconds. */
const GET_SPACING_MS = 70;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries a rate-limited fetch a couple of times before giving up. A 429
 * means "too fast", not "broken" -- treating it as a permanent failure
 * silently drops real messages from the backfill. */
async function fetchWithRateLimitRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const rateLimited = message.includes("429") || message.includes("rateLimitExceeded") || message.includes("quota");
      if (!rateLimited) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

type SearchPage = { ids: string[]; nextPageToken: string | null };

async function searchSentPage(accessToken: string, query: string, pageToken: string | null): Promise<SearchPage> {
  const params = new URLSearchParams({ q: query, maxResults: "100" });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // This environment's HTTP/2 connections occasionally hang rather than
    // erroring, which has silently stalled whole batches here before.
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Gmail messages.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    ids: (data.messages ?? []).map((m: { id: string }) => m.id),
    nextPageToken: data.nextPageToken ?? null,
  };
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const accountEmail: string | undefined = body.accountEmail;
  const pageToken: string | null = body.pageToken ?? null;
  /** Gmail query date form, YYYY/MM/DD. Defaults to the start of the
   * outreach this board covers. */
  const after: string = body.after ?? "2026/08/01";

  const admin = createAdminClient();
  const { data: accounts } = await admin.from("connected_accounts").select("id, email_address").eq("status", "active");
  const account = accountEmail
    ? (accounts ?? []).find((a) => a.email_address === accountEmail)
    : (accounts ?? [])[0];
  if (!account) {
    return NextResponse.json({ error: "No such active account", accounts: (accounts ?? []).map((a) => a.email_address) }, { status: 400 });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(admin, account.id);
  } catch (err) {
    return NextResponse.json(
      { error: "token", account: account.email_address, detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  let recorded = 0;
  let skipped = 0;
  let scanned = 0;
  let failed = 0;
  const failures: string[] = [];
  let token = pageToken;
  let stoppedOnDeadline = false;

  try {
  do {
    // Held so that stopping partway through a page resumes at THIS page
    // rather than the next one -- advancing the cursor before the page is
    // fully processed would silently skip its remainder.
    const currentToken = token;
    const page = await fetchWithRateLimitRetry(() => searchSentPage(accessToken, `in:sent after:${after}`, currentToken));
    token = page.nextPageToken;

    // Skip anything already recorded before spending a fetch on it -- a
    // re-run of this backfill should be nearly free.
    const { data: known } = await admin
      .from("manual_sends")
      .select("gmail_message_id")
      .eq("connected_account_id", account.id)
      .in("gmail_message_id", page.ids);
    const knownIds = new Set((known ?? []).map((k: { gmail_message_id: string }) => k.gmail_message_id));

    for (const id of page.ids) {
      scanned++;
      if (knownIds.has(id)) {
        skipped++;
        continue;
      }
      if (Date.now() - startedAt > DEADLINE_MS) {
        stoppedOnDeadline = true;
        token = currentToken;
        break;
      }
      try {
        const email = await fetchWithRateLimitRetry(() => fetchGmailMessage(accessToken, id));
        await recordManualSend(admin, account.id, email);
        recorded++;
      } catch (err) {
        // One unreadable message must not end the pass -- but it must not
        // vanish either. Swallowing these is what made the first run look
        // like it had simply found nothing to do.
        failed++;
        if (failures.length < 5) failures.push(err instanceof Error ? err.message.slice(0, 160) : String(err));
      }
      await sleep(GET_SPACING_MS);
    }
  } while (token && !stoppedOnDeadline && Date.now() - startedAt < DEADLINE_MS);
  } catch (err) {
    // Report what actually went wrong rather than letting the throw
    // become an empty 500 the caller cannot act on.
    return NextResponse.json(
      {
        error: "scan",
        detail: err instanceof Error ? err.message : String(err),
        account: account.email_address,
        scanned,
        recorded,
        failed,
        failures,
        resumeFrom: token,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    account: account.email_address,
    scanned,
    recorded,
    skipped,
    failed,
    failures,
    stoppedOnDeadline,
    // Null means this account is finished.
    nextPageToken: token,
    elapsedMs: Date.now() - startedAt,
  });
}
