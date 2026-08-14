import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const { id, lat, lng } = await request.json();

  if (!id || typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
    return NextResponse.json({ error: "id, lat, lng required" }, { status: 400 });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json({ error: "lat/lng out of range" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("geo_locations")
    .update({ lat, lng, status: "success", resolved_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
