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

  const accessToken = await getAccessToken(admin, account.id);

  let recorded = 0;
  let skipped = 0;
  let scanned = 0;
  let token = pageToken;
  let stoppedOnDeadline = false;

  do {
    // Held so that stopping partway through a page resumes at THIS page
    // rather than the next one -- advancing the cursor before the page is
    // fully processed would silently skip its remainder.
    const currentToken = token;
    const page = await searchSentPage(accessToken, `in:sent after:${after}`, currentToken);
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
        const email = await fetchGmailMessage(accessToken, id);
        await recordManualSend(admin, account.id, email);
        recorded++;
      } catch {
        // One unreadable message must not end the pass; the next run
        // picks it up again.
      }
    }
  } while (token && !stoppedOnDeadline && Date.now() - startedAt < DEADLINE_MS);

  return NextResponse.json({
    account: account.email_address,
    scanned,
    recorded,
    skipped,
    stoppedOnDeadline,
    // Null means this account is finished.
    nextPageToken: token,
    elapsedMs: Date.now() - startedAt,
  });
}
