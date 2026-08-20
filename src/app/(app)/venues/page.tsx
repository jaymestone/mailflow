import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { searchContacts, type ContactSearchFilters } from "@/lib/venues/searchContacts";

const PAGE_SIZE = 50;

type SearchParams = ContactSearchFilters & { page?: string };

export default async function VenuesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const supabase = await createClient();

  const { data: lists } = await supabase.from("lists").select("id, name").order("name");

  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { rows: contacts, count, isRadiusMode, radiusNote, radiusCapped } = await searchContacts(
    supabase,
    params,
    { from, to },
  );

  const RADIUS_RESULT_CAP = 500;
  const listNameById = new Map((lists ?? []).map((l) => [l.id, l.name]));
  const totalPages = isRadiusMode ? 1 : count ? Math.ceil(count / PAGE_SIZE) : 1;

  function buildPageHref(targetPage: number) {
    const usp = new URLSearchParams(params as Record<string, string>);
    usp.set("page", String(targetPage));
    return `/venues?${usp.toString()}`;
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-[32px] font-medium text-ink">Venues</h1>
        <span className="text-[13px] text-muted-3">{count ?? 0} total</span>
      </div>
      <p className="mt-2 max-w-[52ch] text-sm text-muted">
        Your contact book: every booker, promoter, and venue owner across active lists.
      </p>

      <form className="mt-7 flex flex-wrap items-end gap-6 border-b border-hairline pb-5 text-sm" action="/venues">
        <Field label="List">
          <select
            name="list"
            defaultValue={params.list ?? ""}
            className="w-[120px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none"
          >
            <option value="">All lists</option>
            {(lists ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State">
          <input
            name="state"
            defaultValue={params.state ?? ""}
            placeholder="CA"
            className="w-[60px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="City">
          <input
            name="city"
            defaultValue={params.city ?? ""}
            placeholder="San Francisco"
            className="w-[150px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Country">
          <input
            name="country"
            defaultValue={params.country ?? ""}
            placeholder="United States"
            className="w-[150px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Venue type">
          <input
            name="venue_type"
            defaultValue={params.venue_type ?? ""}
            placeholder="Festival"
            className="w-[110px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Search">
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="venue, city, contact"
            className="w-[200px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <button
          type="submit"
          className="self-end rounded-[2px] bg-ink px-[18px] py-2 text-xs font-semibold text-surface"
        >
          Filter
        </button>
        {(params.list || params.country || params.state || params.city || params.venue_type || params.q) && (
          <Link href="/venues" className="pb-2 text-xs text-muted-3 hover:text-accent">
            Clear
          </Link>
        )}
      </form>

      <form className="mt-4 flex flex-wrap items-end gap-6 border-b border-hairline pb-5 text-sm" action="/venues">
        <span className="pb-1.5 text-xs text-faint">Or by distance:</span>
        <Field label="Near">
          <input
            name="near"
            defaultValue={params.near ?? ""}
            placeholder="San Francisco, CA"
            className="w-[180px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Min miles">
          <input
            name="radius_min"
            type="number"
            min={0}
            defaultValue={params.radius_min ?? ""}
            placeholder="0"
            className="w-[70px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <Field label="Max miles">
          <input
            name="radius_max"
            type="number"
            min={0}
            defaultValue={params.radius_max ?? ""}
            placeholder="50"
            className="w-[70px] border-0 border-b border-rule bg-transparent px-0.5 py-1 text-[13px] text-ink outline-none placeholder:text-faint-3"
          />
        </Field>
        <button
          type="submit"
          className="self-end rounded-[2px] bg-ink px-[18px] py-2 text-xs font-semibold text-surface"
        >
          Search
        </button>
        {params.near && (
          <Link href="/venues" className="pb-2 text-xs text-muted-3 hover:text-accent">
            Clear
          </Link>
        )}
      </form>

      {radiusNote && (
        <p className="mt-4 text-pretty text-sm text-muted">
          {radiusNote}
          {radiusCapped && ` — showing the nearest ${RADIUS_RESULT_CAP}.`}
        </p>
      )}

      <div className="mt-2 overflow-x-auto">
        <div className="grid min-w-[880px] grid-cols-[1.6fr_1fr_1.2fr_1.6fr_1fr_0.8fr] border-b border-hairline-strong py-2.5 text-[10px] tracking-wide text-faint uppercase">
          <span>Venue</span>
          <span>Type</span>
          <span>Contact</span>
          <span>Email</span>
          <span>Location</span>
          <span>Geo</span>
        </div>
        {(contacts ?? []).map((c) => (
          <div
            key={c.id}
            className="grid min-w-[880px] grid-cols-[1.6fr_1fr_1.2fr_1.6fr_1fr_0.8fr] items-center border-b border-hairline-soft py-[11px] text-[13px]"
          >
            <span className="font-display text-[15px] text-ink">{c.venue ?? "—"}</span>
            <span className="text-muted-2">{c.venue_type ?? "—"}</span>
            <span className="text-ink-soft">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</span>
            <span className="text-muted-2">{c.email}</span>
            <span className="text-muted-2">{[c.city, c.state].filter(Boolean).join(", ") || c.country || "—"}</span>
            <GeoBadge status={c.geocode_status} />
          </div>
        ))}
        {(contacts ?? []).length === 0 && (
          <div className="min-w-[880px] py-8 text-center text-sm text-muted-3">No venues match these filters.</div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="mt-5 flex items-center gap-4 text-[13px] text-muted-2">
          <PageLink disabled={page <= 1} href={buildPageHref(page - 1)}>
            ← Prev
          </PageLink>
          <span>
            Page {page} of {totalPages}
          </span>
          <PageLink disabled={page >= totalPages} href={buildPageHref(page + 1)}>
            Next →
          </PageLink>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] tracking-wide text-faint uppercase">{label}</span>
      {children}
    </label>
  );
}

function GeoBadge({ status }: { status: string }) {
  const tone =
    status === "success" ? "text-success" : status === "failed" || status === "no_match" ? "text-error" : "text-faint";
  return <span className={`text-[11px] ${tone}`}>{status}</span>;
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-faint-3">{children}</span>;
  }
  return (
    <Link href={href} className="text-muted-2 no-underline hover:text-accent hover:underline">
      {children}
    </Link>
  );
}
