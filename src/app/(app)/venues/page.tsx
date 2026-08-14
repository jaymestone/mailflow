import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 50;

type SearchParams = {
  list?: string;
  country?: string;
  state?: string;
  city?: string;
  venue_type?: string;
  q?: string;
  page?: string;
};

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

  let query = supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, email, venue, venue_type, city, state, country, list_id, geocode_status",
      { count: "exact" },
    )
    .order("venue", { ascending: true, nullsFirst: false })
    .range(from, to);

  if (params.list) query = query.eq("list_id", params.list);
  if (params.country) query = query.ilike("country", params.country);
  if (params.state) query = query.ilike("state", params.state);
  if (params.city) query = query.ilike("city", params.city);
  if (params.venue_type) query = query.ilike("venue_type", `%${params.venue_type}%`);
  if (params.q) {
    query = query.or(
      `venue.ilike.%${params.q}%,city.ilike.%${params.q}%,first_name.ilike.%${params.q}%,last_name.ilike.%${params.q}%,email.ilike.%${params.q}%`,
    );
  }

  const { data: contacts, count } = await query;
  const listNameById = new Map((lists ?? []).map((l) => [l.id, l.name]));
  const totalPages = count ? Math.ceil(count / PAGE_SIZE) : 1;

  function buildPageHref(targetPage: number) {
    const usp = new URLSearchParams(params as Record<string, string>);
    usp.set("page", String(targetPage));
    return `/venues?${usp.toString()}`;
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-balance text-2xl font-semibold">Venues</h1>
        <span className="text-sm text-neutral-500">{count ?? 0} total</span>
      </div>

      <form className="mt-4 flex flex-wrap items-end gap-3 text-sm" action="/venues">
        <Field label="List">
          <select
            name="list"
            defaultValue={params.list ?? ""}
            className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100"
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
            className="w-24 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100"
          />
        </Field>
        <Field label="City">
          <input
            name="city"
            defaultValue={params.city ?? ""}
            placeholder="San Francisco"
            className="w-40 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100"
          />
        </Field>
        <Field label="Country">
          <input
            name="country"
            defaultValue={params.country ?? ""}
            placeholder="United States"
            className="w-40 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100"
          />
        </Field>
        <Field label="Venue type">
          <input
            name="venue_type"
            defaultValue={params.venue_type ?? ""}
            placeholder="Festival"
            className="w-32 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100"
          />
        </Field>
        <Field label="Search">
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="venue, city, contact, email"
            className="w-56 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-neutral-100"
          />
        </Field>
        <button
          type="submit"
          className="rounded-md bg-neutral-50 px-3 py-1.5 text-sm font-medium text-neutral-950"
        >
          Filter
        </button>
        {(params.list || params.country || params.state || params.city || params.venue_type || params.q) && (
          <Link href="/venues" className="text-xs text-neutral-500 hover:text-neutral-300">
            Clear
          </Link>
        )}
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2">Venue</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Contact</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Country</th>
              <th className="px-3 py-2">List</th>
              <th className="px-3 py-2">Geo</th>
            </tr>
          </thead>
          <tbody>
            {(contacts ?? []).map((c) => (
              <tr key={c.id} className="border-b border-neutral-900 hover:bg-neutral-900/50">
                <td className="px-3 py-2 text-neutral-100">{c.venue ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{c.venue_type ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">
                  {[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}
                </td>
                <td className="px-3 py-2 text-neutral-400">{c.email}</td>
                <td className="px-3 py-2 text-neutral-400">{c.city ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{c.state ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{c.country ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">
                  {c.list_id ? (listNameById.get(c.list_id) ?? "—") : "—"}
                </td>
                <td className="px-3 py-2">
                  <GeoBadge status={c.geocode_status} />
                </td>
              </tr>
            ))}
            {(contacts ?? []).length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-neutral-500">
                  No venues match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center gap-2 text-sm">
          <PageLink disabled={page <= 1} href={buildPageHref(page - 1)}>
            Prev
          </PageLink>
          <span className="text-neutral-500">
            Page {page} of {totalPages}
          </span>
          <PageLink disabled={page >= totalPages} href={buildPageHref(page + 1)}>
            Next
          </PageLink>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function GeoBadge({ status }: { status: string }) {
  const tone =
    status === "success"
      ? "text-emerald-400"
      : status === "failed" || status === "no_match"
        ? "text-red-400"
        : "text-neutral-500";
  return <span className={`text-xs ${tone}`}>{status}</span>;
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
    return <span className="rounded-md px-2 py-1 text-neutral-700">{children}</span>;
  }
  return (
    <Link href={href} className="rounded-md px-2 py-1 text-neutral-300 hover:bg-neutral-900">
      {children}
    </Link>
  );
}
