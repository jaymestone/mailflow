import { createClient } from "@/lib/supabase/server";
import { RestoreButton } from "./bounces-client";

export default async function BouncesPage() {
  const supabase = await createClient();

  const { data: suppressed } = await supabase
    .from("suppression")
    .select("id, email, reason, notes, created_at, campaign:campaigns(name)")
    .order("created_at", { ascending: false })
    .limit(500);

  const bounces = (suppressed ?? []).filter((s) => s.reason === "bounce");
  const optOuts = (suppressed ?? []).filter((s) => s.reason === "opt_out");
  const manual = (suppressed ?? []).filter((s) => s.reason === "manual");

  return (
    <div>
      <h1 className="text-balance text-2xl font-semibold">Bounces &amp; suppression</h1>
      <p className="mt-2 text-pretty text-sm text-neutral-400">
        Every address here is skipped on every future send, and never re-added by an import — the
        suppression list is the permanent do-not-contact record.
      </p>

      <div className="mt-6 grid grid-cols-3 gap-4 text-center">
        <Stat label="Bounced" value={bounces.length} tone="text-red-400" />
        <Stat label="Opted out" value={optOuts.length} tone="text-amber-400" />
        <Stat label="Manually suppressed" value={manual.length} />
      </div>

      <Table title="Bounced addresses" rows={bounces} />
      <Table title="Opted out" rows={optOuts} />
      {manual.length > 0 && <Table title="Manually suppressed" rows={manual} />}
    </div>
  );
}

type Row = {
  id: string;
  email: string;
  reason: string;
  notes: string | null;
  created_at: string;
  campaign: { name: string } | { name: string }[] | null;
};

function Table({ title, rows }: { title: string; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Campaign</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const campaign = Array.isArray(r.campaign) ? r.campaign[0] : r.campaign;
              return (
                <tr key={r.id} className="border-b border-neutral-900">
                  <td className="px-3 py-2 text-neutral-100">{r.email}</td>
                  <td className="px-3 py-2 text-neutral-400">{campaign?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-neutral-500">{new Date(r.created_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <RestoreButton id={r.id} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 p-4">
      <div className={`text-2xl font-semibold ${tone ?? "text-neutral-50"}`}>{value}</div>
      <div className="text-pretty text-xs text-neutral-500">{label}</div>
    </div>
  );
}
