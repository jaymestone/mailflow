import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeThread, type ThreadMessage } from "./summarize";
import { computeIsLive, computeStatus } from "./status";

/** Writes the gist, fee and artist onto conversations that have moved.
 *
 * This is the expensive pass -- one model call per conversation -- so it
 * is strictly bounded rather than run over the board. Two limits apply at
 * once: a count, and a wall-clock deadline.
 *
 * The deadline is the one that matters. cron-job.org disconnects at 30
 * seconds and that disconnect KILLS the in-flight Vercel function rather
 * than just misreporting it, so work already done but not yet written is
 * lost. Checking the clock before starting each conversation means a slow
 * batch finishes short rather than being cut off mid-write.
 */

const MAX_PER_TICK = 3;
/** Leaves room for the final writes plus the heartbeat inside the 30s
 * ceiling, given each summarise call may itself take up to 20s. */
const DEADLINE_MS = 18_000;

/** How long a thread waits after its Nth consecutive failure, in minutes.
 *
 * Front-loaded because the common failure here is the 20s timeout firing on
 * a slow call, which the next tick usually gets through -- so the first
 * retry should be soon. Past the fourth, the thread is failing for a reason
 * a retry will not fix (a body that always times out, a response that never
 * parses) and once a day is enough to notice it recovering without paying
 * for the discovery. The last entry is the cap. */
const BACKOFF_MINUTES = [15, 60, 240, 1440];

export type SummarizeTickResult = {
  candidates: number;
  summarized: number;
  failed: number;
  /** Threads that have changed but are serving a backoff. Surfaced so a
   * thread stuck at the 24h cap is visible in cron_health instead of just
   * quietly never appearing. */
  blocked: number;
  stoppedOnDeadline: boolean;
  errors: string[];
};

type ConversationRow = {
  id: string;
  thread_key: string;
  gmail_thread_ids: string[];
  summary_source_hash: string | null;
  summarized_source_hash: string | null;
  summarized_at: string | null;
  status_override: string | null;
  last_message_at: string | null;
  last_direction: "inbound" | "outbound" | null;
  summarize_attempts: number | null;
  summarize_blocked_until: string | null;
  revision: number | null;
};

type StaleFields = {
  summarized_at: string | null;
  last_message_at: string | null;
  summary_source_hash: string | null;
  summarized_source_hash: string | null;
};

/** Whether this thread's gist is missing or was written from a different
 * set of messages than the thread now holds.
 *
 * The hash comparison is the real test. buildTick derives
 * summary_source_hash from the thread's message set, and that set is
 * exactly what renderThread turns into the prompt -- so an unchanged hash
 * means a byte-identical prompt and therefore the same summary back.
 * Paying for that call buys nothing.
 *
 * Timestamps were the previous test and are kept only as a fallback for
 * rows built before the hash column was populated. They are a weaker
 * question: last_message_at and summarized_at can both move for reasons
 * that have nothing to do with the thread's contents, and when they do,
 * every live conversation bills a fresh Opus call to regenerate the gist
 * it already had.
 */
export function isStale(row: StaleFields): boolean {
  if (!row.summarized_at) return true;
  if (row.summary_source_hash) return row.summary_source_hash !== row.summarized_source_hash;
  return row.last_message_at !== null && row.summarized_at < row.last_message_at;
}

/** Whether this thread is serving a backoff from earlier failures.
 *
 * Deliberately not cleared when a new message arrives. The failures that
 * reach the 24h cap are ones a different message will not fix, and letting
 * fresh activity reset the clock is what would turn a permanently broken
 * thread back into a per-tick charge. */
export function isBlocked(row: { summarize_blocked_until: string | null }, now: Date): boolean {
  return row.summarize_blocked_until !== null && new Date(row.summarize_blocked_until) > now;
}

/** Minutes to hold a thread back after `attempts` consecutive failures. */
export function backoffMinutes(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
}

export function needsSummary(row: StaleFields & { summarize_blocked_until: string | null }, now: Date): boolean {
  return isStale(row) && !isBlocked(row, now);
}

export async function runConversationSummarizeTick(
  supabase: SupabaseClient,
  opts: { now?: Date; startedAt?: number } = {},
): Promise<SummarizeTickResult> {
  const now = opts.now ?? new Date();
  const startedAt = opts.startedAt ?? Date.now();
  const result: SummarizeTickResult = {
    candidates: 0,
    summarized: 0,
    failed: 0,
    blocked: 0,
    stoppedOnDeadline: false,
    errors: [],
  };

  // A conversation needs (re)summarising when its message set has changed
  // since its gist was written, or when it has never been summarised.
  //
  // That test compares two columns, which PostgREST cannot express as a
  // filter, so the staleness check happens here instead. Cheap at this
  // size -- the live board is a few hundred rows, one page -- and it
  // avoids a schema change purely to let the database ask the question.
  const { data: candidates, error } = await supabase
    .from("conversations")
    .select("id, thread_key, gmail_thread_ids, summary_source_hash, summarized_source_hash, summarized_at, status_override, last_message_at, last_direction, summarize_attempts, summarize_blocked_until, revision")
    .eq("is_live", true)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1000);
  if (error) throw new Error(`summarize: selecting candidates -- ${error.message}`);

  // Newest activity first: if the batch cannot reach everything, the
  // threads that moved most recently are the ones worth being current.
  const stale = ((candidates ?? []) as ConversationRow[]).filter(isStale);
  const rows = stale.filter((r) => !isBlocked(r, now));
  result.candidates = rows.length;
  result.blocked = stale.length - rows.length;

  for (const row of rows.slice(0, MAX_PER_TICK)) {
    if (Date.now() - startedAt > DEADLINE_MS) {
      result.stoppedOnDeadline = true;
      break;
    }

    try {
      const messages = await loadThreadMessages(supabase, row.gmail_thread_ids);
      if (messages.length === 0) continue;

      const summary = await summarizeThread(messages);

      const status = computeStatus({
        isAgreed: summary.is_agreed,
        isSmall: summary.is_small,
        feeAmount: summary.fee_amount,
        lastDirection: row.last_direction,
      });
      const isLive = computeIsLive({
        lastMessageAt: row.last_message_at,
        feeAmount: summary.fee_amount,
        isAgreed: summary.is_agreed,
        now,
      });

      const { error: writeError } = await supabase
        .from("conversations")
        .update({
          gist: summary.gist,
          next_action: summary.next_action || null,
          fee_amount: summary.fee_amount,
          fee_note: summary.fee_note,
          artist: summary.artist,
          // The booking-sheet reading; the workbook tick places it.
          sheet_artists: summary.sheet_artists ?? [],
          sheet_dates: summary.sheet_dates ?? [],
          sheet_window: summary.sheet_window ?? null,
          sheet_interest: summary.sheet_interest ?? null,
          sheet_routing_area: summary.sheet_routing_area ?? null,
          sheet_note: summary.sheet_note ?? null,
          sheet_next_step: summary.next_action || null,
          // Only fill the venue from the summary when the contact record
          // did not already supply one -- the catalogue name is the one
          // Jayme's lists and segments use, and letting a venue's own
          // phrasing overwrite it would split the same venue in two.
          ...(summary.venue ? { venue: summary.venue } : {}),
          // His override still wins; this pass proposes, it does not
          // overrule a correction he made in Notion.
          status: row.status_override ?? status,
          is_live: isLive,
          summarized_at: now.toISOString(),
          // Records WHICH messages this gist was written from, so the next
          // tick can tell "already current" from "needs redoing". Taken
          // from the row read at the top of the batch rather than
          // recomputed: if a message landed while this call was in flight,
          // the hash on the row has already moved on and the thread should
          // stay a candidate, not be marked current from stale input.
          summarized_source_hash: row.summary_source_hash,
          // One success clears the whole failure history: the next failure
          // should start again at the short wait rather than inherit a
          // stale count from a problem that has since gone away.
          summarize_attempts: 0,
          summarize_blocked_until: null,
          // gist, next_action, fee_amount and artist are all on the Notion
          // card, and this pass is the only writer of them. The build pass
          // used to bump every row's revision on every run, which hid that
          // -- now that it only bumps what it actually changed, a new gist
          // would never reach Notion unless this says so.
          revision: (row.revision ?? 0) + 1,
          updated_at: now.toISOString(),
        })
        .eq("id", row.id);
      if (writeError) throw new Error(writeError.message);

      result.summarized++;
    } catch (err) {
      result.failed++;
      const attempts = (row.summarize_attempts ?? 0) + 1;
      const wait = backoffMinutes(attempts);
      result.errors.push(
        `${row.thread_key}: ${err instanceof Error ? err.message : "unknown"} (attempt ${attempts}, retry in ${wait}m)`,
      );
      // Recording the failure is what stops this thread being retried on
      // every tick from here on. Its own failure must not replace the real
      // error in the report, so it is caught and appended rather than
      // thrown -- and if it does fail, the worst case is the previous
      // behaviour of retrying next tick.
      const { error: backoffError } = await supabase
        .from("conversations")
        .update({
          summarize_attempts: attempts,
          summarize_blocked_until: new Date(now.getTime() + wait * 60_000).toISOString(),
        })
        .eq("id", row.id);
      if (backoffError) result.errors.push(`${row.thread_key}: recording backoff -- ${backoffError.message}`);
    }
  }

  return result;
}

/** Gathers both sides of a conversation across every Gmail thread it spans. */
async function loadThreadMessages(supabase: SupabaseClient, threadIds: string[]): Promise<ThreadMessage[]> {
  if (threadIds.length === 0) return [];

  const [inbound, manual] = await Promise.all([
    supabase
      .from("inbound_messages")
      .select("subject, body_text, from_email, received_at")
      .in("gmail_thread_id", threadIds),
    supabase.from("manual_sends").select("subject, body_text, from_email, sent_at").in("gmail_thread_id", threadIds),
  ]);

  const messages: ThreadMessage[] = [];
  for (const m of inbound.data ?? []) {
    messages.push({
      direction: "inbound",
      from: m.from_email ?? "",
      sentAt: m.received_at,
      subject: m.subject,
      body: m.body_text,
    });
  }
  for (const m of manual.data ?? []) {
    messages.push({
      direction: "outbound",
      from: m.from_email,
      sentAt: m.sent_at,
      subject: m.subject,
      body: m.body_text,
    });
  }
  return messages;
}
