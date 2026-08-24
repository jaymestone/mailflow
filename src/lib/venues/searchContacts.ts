import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveLocation } from "@/lib/geocode/resolveLocation";

const MILES_TO_METERS = 1609.34;
const RADIUS_RESULT_CAP = 500;
const DEFAULT_RADIUS_MAX_MILES = 50;

export type ContactSearchFilters = {
  list?: string;
  segment?: string;
  country?: string;
  state?: string;
  city?: string;
  venue_type?: string;
  q?: string;
  near?: string;
  radius_min?: string;
  radius_max?: string;
  // Reply-history filters. `campaign` alone (no `reply_status`) means "is a
  // member of this campaign". `reply_status` alone (no `campaign`) checks
  // across every campaign the contact has ever been part of. Both together
  // scope the status to that one campaign — needed because the same contact
  // can reply differently to different campaigns (e.g. "not interested" on a
  // full-roster pitch but "interested" on a specific artist's follow-up).
  campaign?: string;
  reply_status?: "no_reply" | "any_reply" | string; // or a reply_category value
  never_contacted?: string; // "1" = only contacts with zero outbound sends, ever
  not_active_elsewhere?: string; // "1" = exclude anyone `active` in any campaign
};

export type ContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  venue: string | null;
  venue_type: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  list_id: string | null;
  geocode_status: string;
};

export type ContactSearchResult = {
  rows: ContactRow[];
  count: number | null;
  isRadiusMode: boolean;
  radiusNote: string | null;
  radiusCapped: boolean;
};

/**
 * Shared by the /venues browser and the campaign recipient picker so both
 * support the same filters (including radius and reply-history search)
 * without drifting.
 */
export async function searchContacts(
  supabase: SupabaseClient,
  filters: ContactSearchFilters,
  opts: { from?: number; to?: number; limit?: number } = {},
): Promise<ContactSearchResult> {
  let rows: ContactRow[] | null = null;
  let count: number | null = null;
  let radiusNote: string | null = null;
  let radiusCapped = false;

  const engagementIds = await computeEngagementContactIds(supabase, filters);

  if (filters.near) {
    const center = await resolveLocation(supabase, filters.near);
    if (!center) {
      radiusNote = `Couldn't find a location matching "${filters.near}".`;
    } else {
      // An empty/unset field means "use the default", not "no limit" — a
      // bare `value || fallback` would also wrongly treat an explicit "0"
      // input as unset, so unset is detected before parsing.
      const parsedMin = filters.radius_min?.trim() ? parseFloat(filters.radius_min) : NaN;
      const minMiles = Number.isFinite(parsedMin) ? parsedMin : 0;
      const parsedMax = filters.radius_max?.trim() ? parseFloat(filters.radius_max) : NaN;
      const maxMiles = Number.isFinite(parsedMax) ? parsedMax : DEFAULT_RADIUS_MAX_MILES;
      const resultLimit = opts.limit ?? RADIUS_RESULT_CAP;

      const { data, error } = await supabase.rpc("contacts_search_radius", {
        center_lat: center.lat,
        center_lng: center.lng,
        min_meters: minMiles * MILES_TO_METERS,
        max_meters: maxMiles * MILES_TO_METERS,
        list_filter: filters.list || null,
        result_limit: resultLimit,
      });

      if (error) {
        radiusNote = `Radius search failed: ${error.message}`;
      } else {
        let candidateRows = (data ?? []) as ContactRow[];
        // Computed against the raw RPC result, before the engagement-filter
        // narrows it further — this cap reflects whether *distance* search
        // itself was truncated, not the final filtered count.
        radiusCapped = candidateRows.length === resultLimit;
        if (engagementIds !== null) {
          candidateRows = candidateRows.filter((r) => engagementIds.has(r.id));
        }
        rows = candidateRows;
        count = rows.length;
        radiusNote = `Venues ${minMiles > 0 ? `${minMiles}–` : "within "}${maxMiles} miles of "${filters.near}"`;
      }
    }
  }

  if (rows === null) {
    if (engagementIds !== null && engagementIds.size === 0) {
      rows = [];
      count = 0;
    } else {
      let query = supabase
        .from("contacts")
        .select(
          "id, first_name, last_name, email, venue, venue_type, city, state, country, list_id, geocode_status",
          { count: "exact" },
        )
        .order("venue", { ascending: true, nullsFirst: false });

      if (filters.list) query = query.eq("list_id", filters.list);
      if (filters.country) query = query.ilike("country", filters.country);
      if (filters.state) query = query.ilike("state", filters.state);
      if (filters.city) query = query.ilike("city", filters.city);
      if (filters.venue_type) query = query.ilike("venue_type", `%${filters.venue_type}%`);
      if (filters.q) {
        query = query.or(
          `venue.ilike.%${filters.q}%,city.ilike.%${filters.q}%,first_name.ilike.%${filters.q}%,last_name.ilike.%${filters.q}%,email.ilike.%${filters.q}%`,
        );
      }
      if (engagementIds !== null) query = query.in("id", [...engagementIds]);

      if (opts.from !== undefined && opts.to !== undefined) {
        query = query.range(opts.from, opts.to);
      } else if (opts.limit !== undefined) {
        query = query.limit(opts.limit);
      }

      const result = await query;
      rows = (result.data ?? []) as ContactRow[];
      count = result.count ?? null;
    }
  }

  return { rows, count, isRadiusMode: Boolean(filters.near), radiusNote, radiusCapped };
}

/**
 * Resolves the reply-history / segment / activity filters to a set of
 * eligible contact ids, intersecting every active filter (AND). Returns
 * `null` when none of these filters are set, meaning "no restriction" — the
 * caller can then skip the `.in("id", …)` filter entirely.
 *
 * Done in JS rather than as SQL subqueries on the contacts query itself
 * because a couple of these (never-contacted, not-active-elsewhere) are
 * naturally "NOT IN" checks that PostgREST's query builder can't express
 * without a bespoke SQL function per filter combination. At this app's
 * single-admin, single-org scale, fetching the relevant id sets into memory
 * and intersecting them is simpler to read and maintain than growing the
 * radius RPC into a general-purpose query compiler.
 */
async function computeEngagementContactIds(
  supabase: SupabaseClient,
  filters: ContactSearchFilters,
): Promise<Set<string> | null> {
  const tasks: Promise<Set<string>>[] = [];

  if (filters.segment) tasks.push(segmentContactIds(supabase, filters.segment));
  if (filters.campaign || filters.reply_status) {
    tasks.push(campaignReplyContactIds(supabase, filters.campaign, filters.reply_status));
  }
  // Both of these need "every contact id" as their starting point — fetched
  // once and shared when both filters are active at once, rather than each
  // independently pulling the full contacts table.
  if (filters.never_contacted === "1" || filters.not_active_elsewhere === "1") {
    const allContactIds = allContactIdsPromise(supabase);
    if (filters.never_contacted === "1") tasks.push(neverContactedIds(supabase, allContactIds));
    if (filters.not_active_elsewhere === "1") tasks.push(notActiveElsewhereIds(supabase, allContactIds));
  }

  if (tasks.length === 0) return null;

  const sets = await Promise.all(tasks);
  return sets.reduce((acc, s) => new Set([...acc].filter((id) => s.has(id))));
}

async function segmentContactIds(supabase: SupabaseClient, segmentId: string): Promise<Set<string>> {
  const { data } = await supabase.from("saved_segment_contacts").select("contact_id").eq("segment_id", segmentId);
  return new Set((data ?? []).map((r) => r.contact_id as string));
}

async function campaignReplyContactIds(
  supabase: SupabaseClient,
  campaign: string | undefined,
  replyStatus: string | undefined,
): Promise<Set<string>> {
  // Campaign picked, no status: plain "is a member of this campaign".
  if (campaign && !replyStatus) {
    const { data } = await supabase.from("campaign_members").select("contact_id").eq("campaign_id", campaign);
    return new Set((data ?? []).map((r) => r.contact_id as string));
  }

  if (replyStatus === "no_reply") {
    let memberQuery = supabase.from("campaign_members").select("contact_id");
    if (campaign) memberQuery = memberQuery.eq("campaign_id", campaign);

    let replyQuery = supabase
      .from("inbound_messages")
      .select("matched_contact_id")
      .eq("message_type", "reply")
      .not("matched_contact_id", "is", null);
    if (campaign) replyQuery = replyQuery.eq("matched_campaign_id", campaign);

    const [{ data: members }, { data: replies }] = await Promise.all([memberQuery, replyQuery]);
    const repliedSet = new Set((replies ?? []).map((r) => r.matched_contact_id as string));
    return new Set((members ?? []).map((r) => r.contact_id as string).filter((id) => !repliedSet.has(id)));
  }

  // "any_reply" or a specific reply_category value.
  let query = supabase.from("inbound_messages").select("matched_contact_id").not("matched_contact_id", "is", null);
  if (campaign) query = query.eq("matched_campaign_id", campaign);
  if (replyStatus === "any_reply") {
    query = query.eq("message_type", "reply");
  } else if (replyStatus) {
    query = query.eq("classification_category", replyStatus);
  }
  const { data } = await query;
  return new Set((data ?? []).map((r) => r.matched_contact_id as string));
}

/** Fetches every contact id once; the caller passes the *same* promise
 * reference to both consumers below when both filters are active, so the
 * underlying query still only runs once (awaiting one promise twice
 * doesn't re-trigger it) — no caching or module-level state involved. */
async function allContactIdsPromise(supabase: SupabaseClient): Promise<Set<string>> {
  const { data } = await supabase.from("contacts").select("id");
  return new Set((data ?? []).map((r) => r.id as string));
}

async function neverContactedIds(
  supabase: SupabaseClient,
  allContactIds: Promise<Set<string>>,
): Promise<Set<string>> {
  const [all, { data: sent }] = await Promise.all([allContactIds, supabase.from("outbound_sends").select("contact_id")]);
  const contacted = new Set((sent ?? []).map((r) => r.contact_id as string));
  return new Set([...all].filter((id) => !contacted.has(id)));
}

async function notActiveElsewhereIds(
  supabase: SupabaseClient,
  allContactIds: Promise<Set<string>>,
): Promise<Set<string>> {
  const [all, { data: active }] = await Promise.all([
    allContactIds,
    supabase.from("campaign_members").select("contact_id").eq("member_status", "active"),
  ]);
  const activeSet = new Set((active ?? []).map((r) => r.contact_id as string));
  return new Set([...all].filter((id) => !activeSet.has(id)));
}
