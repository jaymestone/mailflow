import type { SupabaseClient } from "@supabase/supabase-js";

const NOMINATIM_USER_AGENT = "MailFlow-VenueGeocoder/1.0 (jayme@jaymestone.com)";

export type ResolvedLocation = { lat: number; lng: number } | null;

/**
 * Resolves a free-text place ("San Francisco" or "San Francisco, CA") to
 * coordinates for a radius search center. Checks the shared geocode cache
 * first; falls back to a single live Nominatim lookup (and caches the
 * result) since this is a low-frequency, user-initiated action rather than
 * part of the rate-limited bulk backfill.
 */
export async function resolveLocation(
  supabase: SupabaseClient,
  query: string,
): Promise<ResolvedLocation> {
  const [cityPart, statePart] = query.split(",").map((s) => s.trim());
  if (!cityPart) return null;

  let cacheQuery = supabase
    .from("geo_locations")
    .select("lat, lng")
    .eq("status", "success")
    .ilike("city", cityPart)
    .limit(1);
  if (statePart) cacheQuery = cacheQuery.ilike("state", statePart);

  const { data: cached } = await cacheQuery.maybeSingle();
  if (cached?.lat != null && cached?.lng != null) {
    return { lat: cached.lat, lng: cached.lng };
  }

  try {
    const params = new URLSearchParams({ format: "jsonv2", limit: "1", q: query });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { "User-Agent": NOMINATIM_USER_AGENT },
    });
    if (!res.ok) return null;
    const results = (await res.json()) as { lat: string; lon: string }[];
    if (!results || results.length === 0) return null;

    const lat = parseFloat(results[0].lat);
    const lng = parseFloat(results[0].lon);
    return { lat, lng };
  } catch {
    return null;
  }
}
