import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { isLeadGenSpam } from "./spam";
import { normalizeSubject, pickCounterpart, threadKeyFor } from "./threadKey";
import { computeIsLive, computeStatus, type ConversationStatus } from "./status";
import { regionFor } from "./region";

/** Rebuilds the conversation board from the mail Mailflow has ingested.
 *
 * Cheap by design -- no model calls happen here. This pass only groups
 * messages into conversations and works out who is waiting on whom; the
 * gist, the fee and the artist come from the separate summarise pass,
 * which is the expensive one and runs in small batches.
 *
 * Campaign auto-sends are deliberately NOT treated as Jayme writing back.
 * Every live thread has had the sequence sent into it, so counting those
 * as his reply would mark the entire board "awaiting them" and hide every
 * deal actually waiting on him. Only manual_sends -- mail he really wrote
 * -- flips a conversation to outbound.
 */

const PAGE = 1000;

type InboundRow = {
  gmail_thread_id: string | null;
  subject: string | null;
  from_email: string | null;
  received_at: string;
  matched_contact_id: string | null;
  classification_category: string | null;
};

type ManualRow = {
  gmail_thread_id: string | null;
  subject: string | null;
  from_email: string;
  sent_at: string;
};

export type ConversationBuildResult = {
  inboundConsidered: number;
  spamSkipped: number;
  conversations: number;
  created: number;
  updated: number;
  droppedStale: number;
  /** Rows whose Notion-visible fields actually moved, and so got a new
   * revision. In steady state this is 0 and the Notion sync has nothing
   * to do -- which is the signal that was unreadable while every row was
   * bumped on every pass. */
  changed: number;
};

/** PostgREST caps a response at 1000 rows regardless of the limit asked
 * for, so every read here pages explicitly. Getting this wrong returns a
 * silently truncated slice rather than an error -- two reads of the same
 * table disagreed about the category totals before this was noticed. */
async function readAll<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  categories?: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const base = supabase.from(table).select(columns).order("id", { ascending: true }).range(offset, offset + PAGE - 1);
    const { data, error } = await (categories ? base.in("classification_category", categories) : base);
    if (error) throw new Error(`conversations: reading ${table} -- ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function runConversationBuildTick(
  supabase: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<ConversationBuildResult> {
  const now = opts.now ?? new Date();

  const { data: accounts } = await supabase.from("connected_accounts").select("email_address");
  const ownAddresses = new Set((accounts ?? []).map((a: { email_address: string }) => a.email_address.toLowerCase()));

  const inbound = await readAll<InboundRow>(
    supabase,
    "inbound_messages",
    "id, gmail_thread_id, subject, from_email, received_at, matched_contact_id, classification_category",
    ["interested", "follow_up"],
  );

  const manual = await readAll<ManualRow>(supabase, "manual_sends", "id, gmail_thread_id, subject, from_email, sent_at");

  // Venue and region come from the contact record where there is one. The
  // catalogue venue name is the one Jayme's lists and segments already
  // use, so taking it from here keeps the board joinable to the rest of
  // the CRM; the summariser only fills these in when no contact matched.
  const contacts = await readAll<{ id: string; venue: string | null; state: string | null; country: string | null }>(
    supabase,
    "contacts",
    "id, venue, state, country",
  );
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const result: ConversationBuildResult = {
    inboundConsidered: 0,
    spamSkipped: 0,
    conversations: 0,
    created: 0,
    updated: 0,
    droppedStale: 0,
    changed: 0,
  };

  type Agg = {
    threadKey: string;
    threadIds: Set<string>;
    counterpart: string;
    subject: string | null;
    contactId: string | null;
    firstInboundAt: string | null;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    messageIds: string[];
  };
  const byKey = new Map<string, Agg>();

  function agg(key: string, counterpart: string, subject: string | null): Agg {
    let a = byKey.get(key);
    if (!a) {
      a = {
        threadKey: key,
        threadIds: new Set(),
        counterpart,
        subject,
        contactId: null,
        firstInboundAt: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        messageIds: [],
      };
      byKey.set(key, a);
    }
    return a;
  }

  for (const m of inbound) {
    result.inboundConsidered++;
    // Belt and braces: the reply tick now classifies this as 'spam' before
    // it ever reaches 'interested', but the table still holds 1,247
    // historical rows that were classified before that existed.
    if (isLeadGenSpam(m.subject)) {
      result.spamSkipped++;
      continue;
    }
    const counterpart = pickCounterpart([m.from_email ?? ""], ownAddresses);
    if (!counterpart) continue;
    const key = threadKeyFor(counterpart, m.subject);
    const a = agg(key, counterpart, m.subject);
    if (m.gmail_thread_id) a.threadIds.add(m.gmail_thread_id);
    if (m.matched_contact_id && !a.contactId) a.contactId = m.matched_contact_id;
    if (!a.firstInboundAt || m.received_at < a.firstInboundAt) a.firstInboundAt = m.received_at;
    if (!a.lastInboundAt || m.received_at > a.lastInboundAt) a.lastInboundAt = m.received_at;
    a.messageIds.push(`i:${m.gmail_thread_id}:${m.received_at}`);
  }

  // Attaching Jayme's replies to the right conversation, thread id first
  // and normalised subject second. The subject fallback is what survives
  // him replying from a different address than the one the venue wrote to,
  // which mints a thread id no inbound message carries.
  const byThreadId = new Map<string, Agg>();
  const bySubject = new Map<string, Agg>();
  for (const a of byKey.values()) {
    for (const id of a.threadIds) byThreadId.set(id, a);
    const subj = normalizeSubject(a.subject);
    // First writer wins: on the rare subject collision between two venues,
    // attaching his reply to one of them is wrong but attaching it to both
    // would be worse -- it would mark two deals answered on one reply.
    if (subj && !bySubject.has(subj)) bySubject.set(subj, a);
  }

  for (const s of manual) {
    const a =
      (s.gmail_thread_id ? byThreadId.get(s.gmail_thread_id) : undefined) ??
      bySubject.get(normalizeSubject(s.subject));
    if (!a) continue; // a reply in a thread that isn't a booking conversation
    if (s.gmail_thread_id) {
      a.threadIds.add(s.gmail_thread_id);
      byThreadId.set(s.gmail_thread_id, a);
    }
    if (!a.lastOutboundAt || s.sent_at > a.lastOutboundAt) a.lastOutboundAt = s.sent_at;
    a.messageIds.push(`o:${s.gmail_thread_id}:${s.sent_at}`);
  }

  const existing = await readAll<{
    id: string;
    thread_key: string;
    status: ConversationStatus;
    status_override: ConversationStatus | null;
    venue: string | null;
    region: string | null;
    fee_amount: number | null;
    revision: number;
    is_live: boolean;
    last_message_at: string | null;
    last_direction: "inbound" | "outbound" | null;
  }>(
    supabase,
    "conversations",
    "id, thread_key, status, status_override, venue, region, fee_amount, revision, is_live, last_message_at, last_direction",
  );
  const existingByKey = new Map(existing.map((e) => [e.thread_key, e]));

  const rows: Record<string, unknown>[] = [];
  for (const a of byKey.values()) {
    result.conversations++;
    const prior = existingByKey.get(a.threadKey);

    const lastInbound = a.lastInboundAt;
    const lastOutbound = a.lastOutboundAt;
    const lastMessageAt = [lastInbound, lastOutbound].filter(Boolean).sort().pop() ?? null;
    const lastDirection: "inbound" | "outbound" | null =
      !lastMessageAt ? null : lastMessageAt === lastOutbound ? "outbound" : "inbound";

    // Fee and agreement come from the summarise pass. This pass must not
    // assume they are false just because it cannot see them: passing
    // isAgreed: false here reset every Confirmed deal to
    // numbers_on_table, and since the route runs this build before the
    // summariser on every tick, the summariser's verdict never survived a
    // single cycle -- the board showed zero confirmed bookings while the
    // model was correctly reporting Blue Waters as agreed.
    //
    // Both flags are recoverable from the status the summariser last
    // wrote, because 'confirmed' and 'parked' are the only states that
    // encode them. Reading them back keeps that judgment intact while
    // still letting a new message flip the needs_reply/awaiting_them pair,
    // which is the only part this pass actually knows better.
    const feeAmount = prior?.fee_amount ?? null;
    const isAgreed = prior?.status === "confirmed";
    const isSmall = prior?.status === "parked";
    const status = computeStatus({ isAgreed, isSmall, feeAmount, lastDirection });
    const isLive = computeIsLive({ lastMessageAt, feeAmount, isAgreed, now });
    if (prior?.is_live && !isLive) result.droppedStale++;
    if (prior) result.updated++;
    else result.created++;

    const contact = a.contactId ? contactById.get(a.contactId) : undefined;

    // Every row must carry the SAME keys. PostgREST normalises a bulk
    // upsert to the union of the keys it sees and writes NULL into the
    // ones a given row omitted -- so conditionally including venue here
    // did not "leave it alone", it erased it. That silently wiped the
    // venue the summariser had extracted on every build pass, which is
    // why confirmed deals were showing up with no venue name at all.
    //
    // Precedence: the contact record first (its name is the one Jayme's
    // lists use), then whatever is already stored, which is usually the
    // summariser's reading for a thread that never matched a contact.
    const venue = contact?.venue ?? prior?.venue ?? null;
    const region = contact ? regionFor(contact.state, contact.country) : (prior?.region ?? null);
    // status_override is Jayme's column, set in Notion. It is read here
    // and never written, so a correction he makes there survives every
    // rebuild.
    const nextStatus = prior?.status_override ?? status;

    // revision is what the Notion sync tests to decide a row needs
    // pushing (revision > notion_synced_revision), so "changed" has to
    // mean the fields Notion actually shows. Bumping it unconditionally
    // meant every row was permanently ahead of Notion: this pass runs
    // every minute and the sync clears about thirty rows a quarter hour,
    // so the gap only ever widened and `pending` could never reach zero
    // -- it sat at the full size of the board, reporting a backlog that
    // was really just a counter racing itself.
    //
    // Only the fields THIS pass owns are compared. gist, next_action,
    // fee_amount and artist are Notion-visible too, but the summarise
    // pass writes those, and it now bumps the revision itself.
    const unchanged =
      prior !== undefined &&
      prior.venue === venue &&
      prior.region === region &&
      prior.status === nextStatus &&
      prior.last_message_at === lastMessageAt &&
      prior.last_direction === lastDirection &&
      prior.is_live === isLive;
    if (!unchanged) result.changed++;

    rows.push({
      thread_key: a.threadKey,
      venue,
      region,
      gmail_thread_ids: [...a.threadIds],
      contact_id: a.contactId,
      status: nextStatus,
      last_message_at: lastMessageAt,
      last_direction: lastDirection,
      first_inbound_at: a.firstInboundAt,
      is_live: isLive,
      // Changing the hash is what tells the summariser this thread has
      // moved and its gist needs rewriting.
      summary_source_hash: createHash("sha1").update(a.messageIds.sort().join("|")).digest("hex"),
      revision: unchanged ? prior.revision : (prior?.revision ?? 0) + 1,
      updated_at: now.toISOString(),
    });
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase
      .from("conversations")
      .upsert(rows.slice(i, i + 200), { onConflict: "thread_key" });
    if (error) throw new Error(`conversations: upsert -- ${error.message}`);
  }

  return result;
}
