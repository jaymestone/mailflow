import type { SupabaseClient } from "@supabase/supabase-js";

/** Keeps the every-minute conversations tick from re-reading the whole CRM
 * when nothing has changed.
 *
 * The full build reads every interested/follow-up message, every manual
 * send, every contact and every conversation: about 1.4 MB per run, which at
 * once a minute was most of Mailflow's Supabase egress (the account went over
 * its 5 GB plan in October 2026). This gate asks a handful of tiny questions
 * instead -- row counts and latest timestamps -- and only lets the full build
 * run when one of the answers moves. A full run still happens at least hourly,
 * because some board state (a conversation going quiet) changes with time
 * alone.
 */

const KEY = "conversations_change_gate";
export const FULL_RUN_EVERY_MINUTES = 60;

export type GateState = {
  signature: string;
  fullRunAt: string;
  /** Stale threads the summariser could work on now, after the last run. */
  pendingSummaries: number;
  /** Earliest backoff expiry among blocked stale threads. */
  nextRetryAt: string | null;
};

async function count(sb: SupabaseClient, table: string, filter?: (q: any) => any): Promise<number> {
  let q: any = sb.from(table).select("id", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`change gate: counting ${table} -- ${error.message}`);
  return n ?? 0;
}

async function latest(sb: SupabaseClient, table: string, column: string): Promise<string | null> {
  const { data, error } = await sb.from(table).select(column).not(column, "is", null).order(column, { ascending: false }).limit(1);
  if (error) throw new Error(`change gate: latest ${table}.${column} -- ${error.message}`);
  return ((data ?? [])[0] as unknown as Record<string, string> | undefined)?.[column] ?? null;
}

/** Everything the build's output depends on, reduced to a short string. */
export async function computeSignature(sb: SupabaseClient): Promise<string> {
  const parts = await Promise.all([
    count(sb, "inbound_messages", (q) => q.in("classification_category", ["interested", "follow_up"])),
    latest(sb, "inbound_messages", "created_at"),
    latest(sb, "inbound_messages", "classified_at"),
    count(sb, "manual_sends"),
    latest(sb, "manual_sends", "created_at"),
    count(sb, "contacts"),
    latest(sb, "contacts", "updated_at"),
    count(sb, "conversations"),
    latest(sb, "conversations", "updated_at"),
  ]);
  return JSON.stringify(parts);
}

export async function readGate(sb: SupabaseClient): Promise<GateState | null> {
  const { data } = await sb.from("app_settings").select("value").eq("key", KEY).maybeSingle();
  return (data?.value as GateState | undefined) ?? null;
}

export async function writeGate(sb: SupabaseClient, state: GateState): Promise<void> {
  const { error } = await sb.from("app_settings").upsert({ key: KEY, value: state, updated_at: new Date().toISOString() });
  if (error) throw new Error(`change gate: saving -- ${error.message}`);
}

/** Pure decision, so it can be tested without a database. */
export function decide(prev: GateState | null, signature: string, now: Date) {
  const hourly = !prev || now.getTime() - new Date(prev.fullRunAt).getTime() >= FULL_RUN_EVERY_MINUTES * 60_000;
  const changed = !prev || prev.signature !== signature;
  const build = hourly || changed;
  const retryDue = !!prev?.nextRetryAt && new Date(prev.nextRetryAt) <= now;
  const summarize = build || (prev?.pendingSummaries ?? 0) > 0 || retryDue;
  return { build, summarize, reason: hourly ? "hourly" : changed ? "changed" : summarize ? "summaries pending" : "unchanged" };
}
