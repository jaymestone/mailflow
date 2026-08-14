import { createClient } from "@/lib/supabase/server";
import { BackfillRunner, ManualOverrideList } from "./geocoding-client";

export default async function GeocodingPage() {
  const supabase = await createClient();

  const [{ count: pending }, { count: success }, { count: failed }, { count: noMatch }] = await Promise.all([
    supabase.from("geo_locations").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("geo_locations").select("id", { count: "exact", head: true }).eq("status", "success"),
    supabase.from("geo_locations").select("id", { count: "exact", head: true }).eq("status", "failed"),
    supabase.from("geo_locations").select("id", { count: "exact", head: true }).eq("status", "no_match"),
  ]);

  const { data: failedLocations } = await supabase
    .from("geo_locations")
    .select("id, city, state, country, status, attempts, last_error")
    .in("status", ["failed", "no_match"])
    .order("city");

  return (
    <div>
      <h1 className="text-balance text-2xl font-semibold">Geocoding</h1>
      <p className="mt-2 text-pretty text-sm text-neutral-400">
        Venue city/state/country combinations are geocoded once and shared across every contact
        in that location. A backfill tick processes 20 locations at a time against OpenStreetMap
        (rate-limited to 1 request/second) and runs automatically every minute; you can also run
        it manually below.
      </p>

      <div className="mt-6 grid grid-cols-4 gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center">
        <Stat label="Pending" value={pending ?? 0} />
        <Stat label="Resolved" value={success ?? 0} tone="text-emerald-400" />
        <Stat label="No match" value={noMatch ?? 0} tone="text-neutral-400" />
        <Stat label="Failed" value={failed ?? 0} tone="text-red-400" />
      </div>

      <BackfillRunner pendingCount={pending ?? 0} />

      <h2 className="mt-10 text-lg font-medium">Needs manual review</h2>
      <p className="mt-1 text-pretty text-sm text-neutral-400">
        These locations couldn&apos;t be resolved automatically. Set coordinates by hand (e.g. from
        Google Maps) to unblock the contacts at that location.
      </p>
      <ManualOverrideList locations={failedLocations ?? []} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className={`text-2xl font-semibold ${tone ?? "text-neutral-50"}`}>{value}</div>
      <div className="text-pretty text-xs text-neutral-500">{label}</div>
    </div>
  );
}
