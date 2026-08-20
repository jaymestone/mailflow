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
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-[32px] font-medium text-ink">Campaigns</h1>
        <Link
          href="/campaigns/new"
          className="rounded-[2px] bg-ink px-[18px] py-2.5 text-xs font-semibold text-surface no-underline"
        >
          New campaign
        </Link>
      </div>

      <div className="mt-7">
        {(campaigns ?? []).map((c, i) => (
          <Link
            key={c.id}
            href={`/campaigns/${c.id}`}
            className="grid grid-cols-[44px_2fr_1fr_1fr_0.8fr] items-baseline border-b border-hairline py-5 text-ink no-underline"
          >
            <span className="font-display text-xl italic text-faint-2">{String(i + 1).padStart(2, "0")}</span>
            <span>
              <span className="block font-display text-[19px] text-ink">{c.name}</span>
              <span className="text-xs text-muted-3">{c.artists ?? "Full roster"}</span>
            </span>
            <StatusBadge status={c.status} />
            <span className="text-xs text-muted-2">{c.campaign_members?.[0]?.count ?? 0} members</span>
            <span className="text-xs text-faint-2">
              {new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          </Link>
        ))}
        {(campaigns ?? []).length === 0 && (
          <div className="py-8 text-center text-sm text-muted-3">No campaigns yet.</div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "text-success"
      : status === "paused"
        ? "text-warning"
        : "text-faint";
  return <span className={`text-xs capitalize ${tone}`}>&#9679; {status}</span>;
}
