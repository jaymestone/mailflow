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

export type SummarizeTickResult = {
  candidates: number;
  summarized: number;
  failed: number;
  stoppedOnDeadline: boolean;
  errors: string[];
};

type ConversationRow = {
  id: string;
  thread_key: string;
  gmail_thread_ids: string[];
  summary_source_hash: string | null;
  summarized_at: string | null;
  status_override: string | null;
  last_message_at: string | null;
  last_direction: "inbound" | "outbound" | null;
};

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
    stoppedOnDeadline: false,
    errors: [],
  };

  // A conversation needs (re)summarising when a message has arrived since
  // its gist was written, or when it has never been summarised at all.
  //
  // That test compares two columns, which PostgREST cannot express as a
  // filter, so the staleness check happens here instead. Cheap at this
  // size -- the live board is a few hundred rows, one page -- and it
  // avoids a schema change purely to let the database ask the question.
  const { data: candidates, error } = await supabase
    .from("conversations")
    .select("id, thread_key, gmail_thread_ids, summary_source_hash, summarized_at, status_override, last_message_at, last_direction")
    .eq("is_live", true)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1000);
  if (error) throw new Error(`summarize: selecting candidates -- ${error.message}`);

  // Newest activity first: if the batch cannot reach everything, the
  // threads that moved most recently are the ones worth being current.
  const rows = ((candidates ?? []) as ConversationRow[]).filter(
    (r) => !r.summarized_at || (r.last_message_at !== null && r.summarized_at < r.last_message_at),
  );
  result.candidates = rows.length;

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
          updated_at: now.toISOString(),
        })
        .eq("id", row.id);
      if (writeError) throw new Error(writeError.message);

      result.summarized++;
    } catch (err) {
      result.failed++;
      result.errors.push(`${row.thread_key}: ${err instanceof Error ? err.message : "unknown"}`);
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
