import { createClient } from "@/lib/supabase/server";
import { ListsSegmentsClient } from "./lists-client";

export default async function ListsSettingsPage() {
  const supabase = await createClient();

  const [{ data: lists }, { data: segments }] = await Promise.all([
    supabase.from("lists").select("id, name, contacts(count)").order("name"),
    supabase.from("saved_segments").select("id, name, saved_segment_contacts(count)").order("name"),
  ]);

  const listOptions = (lists ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    count: Array.isArray(l.contacts) ? (l.contacts[0]?.count ?? 0) : 0,
  }));
  const segmentOptions = (segments ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    count: Array.isArray(s.saved_segment_contacts) ? (s.saved_segment_contacts[0]?.count ?? 0) : 0,
  }));

  return (
    <div>
      <h1 className="font-display text-[32px] font-medium text-ink">Lists &amp; segments</h1>
      <p className="mt-2 max-w-[62ch] text-pretty text-sm text-muted">
        Lists are where a contact came from — each contact belongs to exactly one, set at import. Segments are
        reusable, hand-picked selections a contact can belong to any number of at once.
      </p>

      <div className="mt-8">
        <ListsSegmentsClient lists={listOptions} segments={segmentOptions} />
      </div>
    </div>
  );
}
