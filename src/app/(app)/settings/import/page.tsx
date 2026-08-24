import { createClient } from "@/lib/supabase/server";
import { ImportTabs } from "./import-tabs";

export default async function ImportPage() {
  const supabase = await createClient();

  const [{ data: lists }, { data: campaigns }] = await Promise.all([
    supabase.from("lists").select("id, name").order("name"),
    supabase.from("campaigns").select("id, name").order("name"),
  ]);

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-[32px] font-medium text-ink">Import contacts</h1>
      <p className="mt-2 text-pretty text-sm text-muted">
        Upload a spreadsheet, or paste in partial details for one or a few contacts and let it fill in what it
        can — venue website, state, venue type — before you add them.
      </p>

      <div className="mt-6">
        <ImportTabs lists={lists ?? []} campaigns={campaigns ?? []} />
      </div>
    </div>
  );
}
