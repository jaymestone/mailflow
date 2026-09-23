import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyClicks, type RawClick } from "./classify";

// Re-runs the group-level classifier over clicks already in the table.
//
// Needed because classification depends on what ELSE a contact clicked,
// which is not knowable at the moment any single click arrives -- a
// scanner's second fetch is what proves the first one was a scanner. So
// the at-click-time flag stays a fast provisional guess and this makes the
// considered call afterwards.
//
// Deliberately idempotent: it recomputes from the raw clicks every time
// rather than reading its own previous verdict, so re-running after a
// threshold change simply produces the better answer, and a run that dies
// half way leaves no inconsistent state behind.

export type BackfillResult = {
  dryRun: boolean;
  contactsExamined: number;
  clicksExamined: number;
  human: number;
  scanner: number;
  uncertain: number;
  /** Clicks whose verdict this run actually changes. */
  changed: number;
  errors: string[];
};

/** Clicks are grouped per contact AND per campaign: the same venue in two
 * campaigns is two separate pieces of evidence, and merging them would
 * invent bursts that never happened. */
function groupKey(contactId: string, campaignId: string): string {
  return `${contactId}|${campaignId}`;
}

export async function backfillClickClassification(
  supabase: SupabaseClient,
  opts: { campaignId?: string; dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const result: BackfillResult = {
    dryRun,
    contactsExamined: 0,
    clicksExamined: 0,
    human: 0,
    scanner: 0,
    uncertain: 0,
    changed: 0,
    errors: [],
  };

  const tokens = await pageAll<{
    token: string;
    contact_id: string | null;
    campaign_id: string | null;
    label: string;
    created_at: string;
  }>(supabase, "link_tokens", "token, contact_id, campaign_id, label, created_at", (q) =>
    opts.campaignId ? q.eq("campaign_id", opts.campaignId) : q,
  );
  const tokenById = new Map(tokens.map((t) => [t.token, t]));
  if (tokenById.size === 0) return result;

  const clicks = await pageAll<{
    id: string;
    token: string;
    clicked_at: string;
    user_agent: string | null;
    is_likely_bot: boolean;
    click_class: string | null;
  }>(supabase, "link_clicks", "id, token, clicked_at, user_agent, is_likely_bot, click_class", (q) => q);

  const grouped = new Map<string, RawClick[]>();
  for (const click of clicks) {
    const token = tokenById.get(click.token);
    if (!token?.contact_id || !token.campaign_id) continue;
    const key = groupKey(token.contact_id, token.campaign_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push({
      id: click.id,
      token: click.token,
      label: token.label,
      clickedAt: click.clicked_at,
      tokenCreatedAt: token.created_at,
      userAgent: click.user_agent,
    });
  }
  result.contactsExamined = grouped.size;

  const priorClass = new Map(clicks.map((c) => [c.id, c.click_class]));
  const originalRow = new Map(clicks.map((c) => [c.id, c]));
  const classifiedAt = new Date().toISOString();
  const updates: { id: string; click_class: string; class_reason: string }[] = [];

  for (const group of grouped.values()) {
    for (const verdict of classifyClicks(group)) {
      result.clicksExamined++;
      result[verdict.clickClass]++;
      if (priorClass.get(verdict.id) !== verdict.clickClass) result.changed++;
      updates.push({ id: verdict.id, click_class: verdict.clickClass, class_reason: verdict.reason });
    }
  }

  if (dryRun) return result;

  // One statement per click would be tens of thousands of round trips.
  // Chunked upserts keep it to a few dozen, and the chunk size is well
  // inside PostgREST's payload limits for rows this small.
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const { error } = await supabase.from("link_clicks").upsert(
      chunk.map((u) => ({
        // Full row: upserting on the primary key takes the UPDATE path for
        // every existing click, but the columns NOT NULL on insert still
        // have to be present for PostgREST to accept the payload.
        id: u.id,
        token: originalRow.get(u.id)!.token,
        clicked_at: originalRow.get(u.id)!.clicked_at,
        user_agent: originalRow.get(u.id)!.user_agent,
        click_class: u.click_class,
        class_reason: u.class_reason,
        classified_at: classifiedAt,
        // Kept in step so the campaign page, contact click history and
        // venue search are corrected without changing their queries --
        // see the migration's note. "uncertain" counts as not-a-human
        // here: those views are about demonstrated interest, and an
        // unproven click is not that.
        is_likely_bot: u.click_class !== "human",
      })),
      { onConflict: "id" },
    );
    if (error) result.errors.push(`chunk at ${i}: ${error.message}`);
  }

  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the
// supabase-js builder types don't survive being passed through a generic
// helper like this; the shapes are pinned by the <T> each caller supplies.
type QueryFilter = (q: any) => any;

async function pageAll<T>(
  supabase: SupabaseClient,
  table: string,
  select: string,
  filter: QueryFilter,
): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const query = filter(supabase.from(table).select(select).range(from, from + size - 1));
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}
