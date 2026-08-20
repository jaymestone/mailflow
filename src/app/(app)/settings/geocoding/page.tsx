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
      <h1 className="font-display text-[32px] font-medium text-ink">Geocoding</h1>
      <p className="mt-2 max-w-[62ch] text-pretty text-sm text-muted">
        Venue city/state/country combinations are geocoded once and shared across every contact
        in that location. A backfill tick processes 20 locations at a time against OpenStreetMap
        (rate-limited to 1 request/second) and runs automatically every minute; you can also run
        it manually below.
      </p>

      <div className="mt-7 grid grid-cols-4 gap-4 rounded-[3px] border border-hairline bg-surface p-5 text-center">
        <Stat label="Pending" value={pending ?? 0} />
        <Stat label="Resolved" value={success ?? 0} tone="text-success" />
        <Stat label="No match" value={noMatch ?? 0} tone="text-muted-2" />
        <Stat label="Failed" value={failed ?? 0} tone="text-error" />
      </div>

      <BackfillRunner pendingCount={pending ?? 0} />

      <h2 className="mt-11 font-display text-[21px] font-medium text-ink">Needs manual review</h2>
      <p className="mt-1.5 max-w-[62ch] text-pretty text-sm text-muted">
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
      <div className={`font-display text-2xl ${tone ?? "text-ink"}`}>{value}</div>
      <div className="mt-1 text-pretty text-xs text-muted-3">{label}</div>
    </div>
  );
}
