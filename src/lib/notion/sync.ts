import type { SupabaseClient } from "@supabase/supabase-js";

/** Pushes the booking board into Notion.
 *
 * One-way, and deliberately partial. Mailflow owns the computed columns;
 * Done and My notes belong to Jayme and are never written here, so an
 * afternoon of ticking boxes cannot be wiped by the next sync. That is
 * the failure mode that makes a synced board worse than no board.
 *
 * status_override is the other half of that bargain: if he changes Status
 * in Notion, the pull step records it and the build pass stops
 * recomputing that row. Without it his correction would be undone within
 * fifteen minutes and he would stop trusting the column.
 */

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

/** Notion allows roughly 3 requests/second per integration and answers a
 * burst with 429s. Each conversation costs one request, so this spacing
 * holds a batch just under the limit. */
const REQUEST_SPACING_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STATUS_LABELS: Record<string, string> = {
  needs_reply: "Needs reply",
  awaiting_them: "Awaiting them",
  numbers_on_table: "Numbers on the table",
  confirmed: "Confirmed",
  parked: "Parked",
};
const STATUS_FROM_LABEL = Object.fromEntries(Object.entries(STATUS_LABELS).map(([k, v]) => [v, k]));

/** Notion rejects a select value that is not already an option on the
 * property, so an artist or region the database has never seen would fail
 * the whole page write. Anything unrecognised is dropped rather than
 * sent -- a missing tag is better than a lost row. */
const ARTIST_OPTIONS = new Set([
  "The Little Mercies", "Samir Langus", "Summer Camargo", "Amanda Pascali",
  "Charlie & the Tropicales", "Rakish", "Sam Reider & the Human Hands",
  "Jorge Glem & Sam Reider", "Lily Henley", "Kavita Shah",
]);
const REGION_OPTIONS = new Set([
  "Northeast", "Southeast", "Midwest", "Mountain West", "Southwest",
  "West Coast", "Canada", "Europe", "Other",
]);

export type ConversationForSync = {
  id: string;
  thread_key: string;
  venue: string | null;
  artist: string | null;
  region: string | null;
  status: string;
  fee_amount: number | null;
  gist: string | null;
  next_action: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  is_live: boolean;
  revision: number;
  notion_page_id: string | null;
  notion_synced_revision: number;
};

export type NotionSyncResult = {
  created: number;
  updated: number;
  archived: number;
  failed: number;
  pending: number;
  stoppedOnDeadline: boolean;
  errors: string[];
};

function text(value: string | null | undefined, cap = 1900) {
  // Notion rejects a rich_text item over 2000 characters outright, which
  // would fail the whole page rather than truncate the field.
  return { rich_text: value ? [{ text: { content: value.slice(0, cap) } }] : [] };
}

function selectOrNull(value: string | null, allowed: Set<string>) {
  return { select: value && allowed.has(value) ? { name: value } : null };
}

function propertiesFor(c: ConversationForSync) {
  return {
    Venue: { title: [{ text: { content: (c.venue || c.thread_key.split("::")[0] || "Unknown").slice(0, 1900) } }] },
    Status: { select: { name: STATUS_LABELS[c.status] ?? "Needs reply" } },
    "Waiting on": { select: c.last_direction ? { name: c.last_direction === "outbound" ? "Them" : "You" } : null },
    Artist: selectOrNull(c.artist, ARTIST_OPTIONS),
    Region: selectOrNull(c.region, REGION_OPTIONS),
    Fee: { number: c.fee_amount ?? null },
    "Where it got left": text(c.gist),
    "Next action": text(c.next_action),
    "Last contact": { date: c.last_message_at ? { start: c.last_message_at.slice(0, 10) } : null },
    Contact: { email: c.thread_key.split("::")[0] || null },
    "Mailflow key": text(c.thread_key),
  };
}

async function notion(path: string, init: RequestInit & { token: string }): Promise<Record<string, unknown>> {
  const { token, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Notion ${res.status}: ${String(body.message ?? "").slice(0, 160)}`);
  return body;
}

/** Detects a Status that Jayme changed in Notion.
 *
 * Only ever called on rows where Notion is already up to date with us
 * (revision === notion_synced_revision). That condition is the whole
 * correctness argument: if Mailflow has an unpushed change, a difference
 * between the two sides means Notion is stale, not that a human edited
 * it. Comparing against the *computed* status instead manufactured
 * overrides out of the sync's own lag -- 30 rows were frozen that way
 * before Jayme had even opened the board, including a confirmed booking
 * pinned back to numbers_on_table. */
async function pullOverride(token: string, pageId: string, syncedStatus: string): Promise<string | null> {
  const page = await notion(`/pages/${pageId}`, { token, method: "GET" });
  const props = (page.properties ?? {}) as Record<string, { select?: { name?: string } | null }>;
  const label = props.Status?.select?.name;
  if (!label) return null;
  const asKey = STATUS_FROM_LABEL[label];
  if (!asKey || asKey === syncedStatus) return null;
  return asKey;
}

export async function syncConversationsToNotion(
  supabase: SupabaseClient,
  opts: { databaseId: string; token: string; startedAt?: number; deadlineMs?: number; maxRows?: number },
): Promise<NotionSyncResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const deadlineMs = opts.deadlineMs ?? 40_000;
  const maxRows = opts.maxRows ?? 60;

  const result: NotionSyncResult = {
    created: 0, updated: 0, archived: 0, failed: 0, pending: 0, stoppedOnDeadline: false, errors: [],
  };

  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, thread_key, venue, artist, region, status, fee_amount, gist, next_action, last_message_at, last_direction, is_live, revision, notion_page_id, notion_synced_revision",
    )
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1000);
  if (error) throw new Error(`notion sync: reading conversations -- ${error.message}`);

  // Column-to-column comparison again, so the staleness test runs here.
  const rows = ((data ?? []) as ConversationForSync[]).filter((r) => r.revision > r.notion_synced_revision);
  result.pending = rows.length;

  for (const row of rows.slice(0, maxRows)) {
    if (Date.now() - startedAt > deadlineMs) {
      result.stoppedOnDeadline = true;
      break;
    }

    try {
      if (!row.is_live) {
        // Dropped off the board. Archive rather than delete: Jayme's notes
        // and checkbox live on that page and archiving keeps them
        // recoverable from Notion's trash.
        if (row.notion_page_id) {
          await notion(`/pages/${row.notion_page_id}`, {
            token: opts.token,
            method: "PATCH",
            body: JSON.stringify({ archived: true }),
          });
          result.archived++;
        }
      } else if (row.notion_page_id) {
        // Push only. Reading Notion here cannot tell a human edit from
        // our own un-pushed change, because by definition this row has
        // one. Human edits are picked up by pullStatusOverrides, which
        // only looks at rows already in sync.
        await notion(`/pages/${row.notion_page_id}`, {
          token: opts.token,
          method: "PATCH",
          body: JSON.stringify({ properties: propertiesFor(row) }),
        });
        result.updated++;
      } else {
        const created = await notion(`/pages`, {
          token: opts.token,
          method: "POST",
          body: JSON.stringify({
            parent: { database_id: opts.databaseId },
            properties: propertiesFor(row),
          }),
        });
        await supabase.from("conversations").update({ notion_page_id: created.id as string }).eq("id", row.id);
        result.created++;
      }

      await supabase
        .from("conversations")
        .update({ notion_synced_revision: row.revision, notion_synced_at: new Date().toISOString() })
        .eq("id", row.id);
    } catch (err) {
      result.failed++;
      if (result.errors.length < 5) {
        result.errors.push(`${row.thread_key.slice(0, 40)}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    await sleep(REQUEST_SPACING_MS);
  }

  return result;
}

export type NotionPullResult = {
  checked: number;
  overridesFound: number;
  failed: number;
  stoppedOnDeadline: boolean;
};

/** Picks up Status changes Jayme made in Notion.
 *
 * Separate from the push pass on purpose. A single pass that both reads
 * and writes cannot tell "he changed this" from "we have not pushed yet",
 * and guessing wrong is expensive in one direction: a manufactured
 * override freezes the row forever, because the build pass then refuses
 * to recompute it.
 *
 * So this only considers rows where Notion already matches us. There, any
 * difference is necessarily a human edit.
 *
 * Checks oldest-checked first so the whole board is covered over
 * successive ticks rather than the same few rows every time.
 */
export async function pullStatusOverridesFromNotion(
  supabase: SupabaseClient,
  opts: { token: string; startedAt?: number; deadlineMs?: number; maxRows?: number },
): Promise<NotionPullResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const deadlineMs = opts.deadlineMs ?? 15_000;
  const maxRows = opts.maxRows ?? 25;

  const result: NotionPullResult = { checked: 0, overridesFound: 0, failed: 0, stoppedOnDeadline: false };

  const { data } = await supabase
    .from("conversations")
    .select("id, status, revision, notion_page_id, notion_synced_revision, notion_synced_at")
    .eq("is_live", true)
    .not("notion_page_id", "is", null)
    .order("notion_synced_at", { ascending: true, nullsFirst: true })
    .limit(200);

  const inSync = ((data ?? []) as Array<{
    id: string;
    status: string;
    revision: number;
    notion_page_id: string;
    notion_synced_revision: number;
  }>).filter((r) => r.revision === r.notion_synced_revision);

  for (const row of inSync.slice(0, maxRows)) {
    if (Date.now() - startedAt > deadlineMs) {
      result.stoppedOnDeadline = true;
      break;
    }
    try {
      result.checked++;
      const override = await pullOverride(opts.token, row.notion_page_id, row.status);
      if (override) {
        await supabase
          .from("conversations")
          .update({ status_override: override, status: override })
          .eq("id", row.id);
        result.overridesFound++;
      }
    } catch {
      result.failed++;
    }
    await sleep(REQUEST_SPACING_MS);
  }

  return result;
}
