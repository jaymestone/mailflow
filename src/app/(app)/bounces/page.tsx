import { createClient } from "@/lib/supabase/server";
import { AddSuppressionForm, RestoreButton, RunReplacementResearchButton } from "./bounces-client";

export default async function BouncesPage() {
  const supabase = await createClient();

  const [{ data: suppressed }, { data: replacementQueue }] = await Promise.all([
    supabase
      .from("suppression")
      .select("id, email, reason, notes, created_at, campaign:campaigns(name)")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("replacement_queue")
      .select(
        "id, venue, city, state, removed_contact_email, removed_reason, removed_at, status, researched_at, notes",
      )
      .order("removed_at", { ascending: false })
      .limit(100),
  ]);

  const bounces = (suppressed ?? []).filter((s) => s.reason === "bounce");
  const optOuts = (suppressed ?? []).filter((s) => s.reason === "opt_out");
  const departed = (suppressed ?? []).filter((s) => s.reason === "departed");
  const manual = (suppressed ?? []).filter((s) => s.reason === "manual");

  const queue = replacementQueue ?? [];
  const pendingCount = queue.filter((q) => q.status === "pending").length;
  const replacedCount = queue.filter((q) => q.status === "replaced").length;
  const noneFoundCount = queue.filter((q) => q.status === "no_replacement_found").length;

  return (
    <div>
      <h1 className="font-display text-[32px] font-medium text-ink">Bounces &amp; suppressions</h1>
      <p className="mt-2 max-w-[62ch] text-pretty text-sm text-muted">
        Addresses removed from future sends to protect deliverability. The suppression list is the
        permanent do-not-contact record and is never re-added by an import.
      </p>

      <div className="mt-7 grid grid-cols-4 gap-5 text-center">
        <Stat label="Bounced" value={bounces.length} tone="text-error" />
        <Stat label="Opted out" value={optOuts.length} tone="text-warning" />
        <Stat label="Departed / venue closed" value={departed.length} tone="text-error" />
        <Stat label="Manually suppressed" value={manual.length} />
      </div>

      <AddSuppressionForm />

      <Table title="Bounced addresses" rows={bounces} />
      <Table title="Opted out" rows={optOuts} />
      {departed.length > 0 && (
        <Table title="Departed / venue closed — needs a contact update" rows={departed} />
      )}
      {manual.length > 0 && <Table title="Manually suppressed" rows={manual} />}

      <section className="mt-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-[21px] font-medium text-ink">Replacement research</h2>
            <p className="mt-1 max-w-[62ch] text-pretty text-xs text-muted-3">
              A hard bounce or departed-contact reply deletes the dead contact automatically and queues
              their venue here. A weekly job researches a fresh contact for each queued venue — only a
              real named person is inserted (a generic inbox is used only as a flagged last resort, and
              a venue is skipped entirely rather than adding a bare generic address).
            </p>
          </div>
          <RunReplacementResearchButton />
        </div>

        <div className="mt-5 grid grid-cols-3 gap-5 text-center">
          <Stat label="Pending research" value={pendingCount} tone={pendingCount > 0 ? "text-warning" : undefined} />
          <Stat label="Replaced" value={replacedCount} />
          <Stat label="No replacement found" value={noneFoundCount} />
        </div>

        {queue.length > 0 && (
          <div className="mt-5">
            <div className="grid grid-cols-[1.3fr_1.4fr_0.9fr_1.6fr_0.7fr] border-b border-hairline-strong py-2 text-[10px] tracking-wide text-faint uppercase">
              <span>Venue</span>
              <span>Removed contact</span>
              <span>Status</span>
              <span>Notes</span>
              <span>Date</span>
            </div>
            {queue.slice(0, 25).map((q) => (
              <div
                key={q.id}
                className="grid grid-cols-[1.3fr_1.4fr_0.9fr_1.6fr_0.7fr] items-center border-b border-hairline-soft py-3 text-[13px]"
              >
                <span className="text-ink">
                  {q.venue ?? "—"}
                  {q.city ? <span className="text-faint-2"> · {q.city}{q.state ? `, ${q.state}` : ""}</span> : null}
                </span>
                <span className="text-muted-2">
                  {q.removed_contact_email}
                  <span className="text-faint-2"> ({q.removed_reason === "bounce" ? "bounced" : "departed"})</span>
                </span>
                <span className={queueStatusTone(q.status)}>{queueStatusLabel(q.status)}</span>
                <span className="truncate text-faint-2" title={q.notes ?? undefined}>
                  {q.notes ?? "—"}
                </span>
                <span className="text-faint-2">{new Date(q.removed_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function queueStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "replaced":
      return "Replaced";
    case "no_replacement_found":
      return "None found";
    case "skipped":
      return "Skipped";
    default:
      return status;
  }
}

function queueStatusTone(status: string): string {
  switch (status) {
    case "pending":
      return "text-warning";
    case "replaced":
      return "text-ink";
    case "no_replacement_found":
      return "text-faint-2";
    default:
      return "text-faint-2";
  }
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
    <section className="mt-10">
      <h2 className="font-display text-[21px] font-medium text-ink">{title}</h2>
      <div className="mt-3">
        <div className="grid grid-cols-[1.6fr_1.2fr_1fr_0.6fr] border-b border-hairline-strong py-2 text-[10px] tracking-wide text-faint uppercase">
          <span>Email</span>
          <span>Campaign</span>
          <span>Date</span>
          <span></span>
        </div>
        {rows.map((r) => {
          const campaign = Array.isArray(r.campaign) ? r.campaign[0] : r.campaign;
          return (
            <div
              key={r.id}
              className="grid grid-cols-[1.6fr_1.2fr_1fr_0.6fr] items-center border-b border-hairline-soft py-3 text-[13px]"
            >
              <span className="text-ink">{r.email}</span>
              <span className="text-muted-2">{campaign?.name ?? "—"}</span>
              <span className="text-faint-2">{new Date(r.created_at).toLocaleDateString()}</span>
              <RestoreButton id={r.id} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-[3px] border border-hairline bg-surface p-5">
      <div className={`font-display text-2xl ${tone ?? "text-ink"}`}>{value}</div>
      <div className="mt-1 text-pretty text-xs text-muted-3">{label}</div>
    </div>
  );
}
