import type { SupabaseClient } from "@supabase/supabase-js";

const BATCH_SIZE = 20;
const REQUEST_SPACING_MS = 1100; // Nominatim's usage policy caps at 1 req/sec.
const MAX_ATTEMPTS = 3;
const NOMINATIM_USER_AGENT = "MailFlow-VenueGeocoder/1.0 (jayme@jaymestone.com)";

type GeoLocationRow = {
  id: string;
  city: string;
  state: string | null;
  country: string | null;
  attempts: number;
};

export type GeocodeTickResult = {
  processed: number;
  success: number;
  noMatch: number;
  failed: number;
  remainingPending: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeOne(row: GeoLocationRow): Promise<
  | { outcome: "success"; lat: number; lng: number }
  | { outcome: "no_match" }
  | { outcome: "error"; message: string }
> {
  const params = new URLSearchParams({ format: "jsonv2", limit: "1" });
  params.set("city", row.city);
  if (row.state) params.set("state", row.state);
  if (row.country) params.set("country", row.country);

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { "User-Agent": NOMINATIM_USER_AGENT },
    });
    if (!res.ok) return { outcome: "error", message: `HTTP ${res.status}` };

    const results = (await res.json()) as { lat: string; lon: string }[];
    if (!results || results.length === 0) return { outcome: "no_match" };

    return { outcome: "success", lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function runGeocodeTick(supabase: SupabaseClient): Promise<GeocodeTickResult> {
  const { data: batch } = await supabase
    .from("geo_locations")
    .select("id, city, state, country, attempts")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  const rows = (batch ?? []) as GeoLocationRow[];
  let success = 0;
  let noMatch = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = await geocodeOne(row);

    if (result.outcome === "success") {
      await supabase
        .from("geo_locations")
        .update({
          lat: result.lat,
          lng: result.lng,
          status: "success",
          resolved_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      success++;
    } else if (result.outcome === "no_match") {
      await supabase
        .from("geo_locations")
        .update({ status: "no_match", attempts: row.attempts + 1 })
        .eq("id", row.id);
      noMatch++;
    } else {
      const attempts = row.attempts + 1;
      await supabase
        .from("geo_locations")
        .update({
          attempts,
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          last_error: result.message,
        })
        .eq("id", row.id);
      if (attempts >= MAX_ATTEMPTS) failed++;
    }

    if (i < rows.length - 1) await sleep(REQUEST_SPACING_MS);
  }

  const { count: remainingPending } = await supabase
    .from("geo_locations")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return {
    processed: rows.length,
    success,
    noMatch,
    failed,
    remainingPending: remainingPending ?? 0,
  };
}
