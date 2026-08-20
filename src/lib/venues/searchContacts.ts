import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveLocation } from "@/lib/geocode/resolveLocation";

const MILES_TO_METERS = 1609.34;
const RADIUS_RESULT_CAP = 500;

export type ContactSearchFilters = {
  list?: string;
  country?: string;
  state?: string;
  city?: string;
  venue_type?: string;
  q?: string;
  near?: string;
  radius_min?: string;
  radius_max?: string;
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
 * support the same filters (including radius search) without drifting.
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

  if (filters.near) {
    const center = await resolveLocation(supabase, filters.near);
    if (!center) {
      radiusNote = `Couldn't find a location matching "${filters.near}".`;
    } else {
      const minMiles = parseFloat(filters.radius_min ?? "0") || 0;
      const maxMiles = filters.radius_max ? parseFloat(filters.radius_max) || null : null;
      const resultLimit = opts.limit ?? RADIUS_RESULT_CAP;

      const { data, error } = await supabase.rpc("contacts_search_radius", {
        center_lat: center.lat,
        center_lng: center.lng,
        min_meters: minMiles * MILES_TO_METERS,
        max_meters: maxMiles ? maxMiles * MILES_TO_METERS : null,
        list_filter: filters.list || null,
        result_limit: resultLimit,
      });

      if (error) {
        radiusNote = `Radius search failed: ${error.message}`;
      } else {
        rows = (data ?? []) as ContactRow[];
        count = rows.length;
        radiusCapped = rows.length === resultLimit;
        radiusNote = maxMiles
          ? `Venues ${minMiles > 0 ? `${minMiles}–` : "within "}${maxMiles} miles of "${filters.near}"`
          : `Venues within ${minMiles} miles of "${filters.near}"`;
      }
    }
  }

  if (rows === null) {
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

    if (opts.from !== undefined && opts.to !== undefined) {
      query = query.range(opts.from, opts.to);
    } else if (opts.limit !== undefined) {
      query = query.limit(opts.limit);
    }

    const result = await query;
    rows = (result.data ?? []) as ContactRow[];
    count = result.count ?? null;
  }

  return { rows, count, isRadiusMode: Boolean(filters.near), radiusNote, radiusCapped };
}
