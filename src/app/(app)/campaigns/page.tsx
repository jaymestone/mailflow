import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function CampaignsPage() {
  const supabase = await createClient();

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, name, artists, status, created_at, campaign_members(count)")
    .order("created_at", { ascending: false });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-balance text-2xl font-semibold">Campaigns</h1>
        <Link
          href="/campaigns/new"
          className="rounded-lg bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
        >
          New campaign
        </Link>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Artist(s)</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Members</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {(campaigns ?? []).map((c) => (
              <tr key={c.id} className="border-b border-neutral-900 hover:bg-neutral-900/50">
                <td className="px-3 py-2">
                  <Link href={`/campaigns/${c.id}`} className="text-neutral-100 hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-neutral-400">{c.artists ?? "—"}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={c.status} />
                </td>
                <td className="px-3 py-2 text-neutral-400">{c.campaign_members?.[0]?.count ?? 0}</td>
                <td className="px-3 py-2 text-neutral-500">
                  {new Date(c.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {(campaigns ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-neutral-500">
                  No campaigns yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "text-emerald-400"
      : status === "paused"
        ? "text-amber-400"
        : status === "completed"
          ? "text-neutral-500"
          : "text-neutral-400";
  return <span className={`text-xs capitalize ${tone}`}>{status}</span>;
}
