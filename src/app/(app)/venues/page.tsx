import { createClient } from "@/lib/supabase/server";
import { VenuesClient } from "./venues-client";

export default async function VenuesPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string; segment?: string }>;
}) {
  const { list, segment } = await searchParams;
  const supabase = await createClient();

  const [{ data: lists }, { data: segments }, { data: campaigns }] = await Promise.all([
    supabase.from("lists").select("id, name").order("name"),
    supabase.from("saved_segments").select("id, name, saved_segment_contacts(count)").order("name"),
    supabase.from("campaigns").select("id, name").order("name"),
  ]);

  const segmentOptions = (segments ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    count: Array.isArray(s.saved_segment_contacts) ? (s.saved_segment_contacts[0]?.count ?? 0) : 0,
  }));

  return (
    <div>
      <h1 className="font-display text-[32px] font-medium text-ink">Venues</h1>
      <p className="mt-2 max-w-[60ch] text-sm text-muted">
        Your contact book: every booker, promoter, and venue owner across active lists. Filter, hand-pick a bespoke
        list, save it for later or send it straight to a campaign.
      </p>

      <div className="mt-7">
        <VenuesClient
          lists={lists ?? []}
          segments={segmentOptions}
          campaigns={campaigns ?? []}
          initialFilters={{ list: list ?? "", segment: segment ?? "" }}
        />
      </div>
    </div>
  );
}
