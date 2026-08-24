import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { TemplateEditor } from "./template-editor";
import { StatusControl, ArchiveDeleteControls, RemoveMemberButton } from "./campaign-controls";
import { RecipientPicker } from "./recipient-picker";
import { SendControls } from "./send-controls";

const MEMBERS_DISPLAY_CAP = 200;

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: campaign } = await supabase.from("campaigns").select("*").eq("id", id).single();
  if (!campaign) notFound();

  const [
    { data: templates },
    { data: savedTemplates },
    { data: lists },
    { data: segments },
    { data: campaigns },
    { data: members },
    { count: memberCount },
  ] = await Promise.all([
    supabase.from("campaign_templates").select("*").eq("campaign_id", id).order("step_number"),
    supabase.from("saved_templates").select("id, name, subject, body").order("name"),
    supabase.from("lists").select("id, name").order("name"),
    supabase.from("saved_segments").select("id, name, saved_segment_contacts(count)").order("name"),
    supabase.from("campaigns").select("id, name").order("name"),
    supabase
      .from("campaign_members")
      .select("id, current_step, member_status, last_sent_at, contact:contacts(id, first_name, last_name, email, venue)")
      .eq("campaign_id", id)
      .order("added_at", { ascending: false })
      .limit(MEMBERS_DISPLAY_CAP),
    supabase.from("campaign_members").select("id", { count: "exact", head: true }).eq("campaign_id", id),
  ]);

  const segmentOptions = (segments ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    count: Array.isArray(s.saved_segment_contacts) ? (s.saved_segment_contacts[0]?.count ?? 0) : 0,
  }));

  const statusCounts: Record<string, number> = {};
  for (const m of members ?? []) {
    statusCounts[m.member_status] = (statusCounts[m.member_status] ?? 0) + 1;
  }

  return (
    <div>
      <Link href="/campaigns" className="text-xs text-muted-3 hover:text-accent">
        ← Campaigns
      </Link>
      <div className="mt-2.5 flex items-start justify-between">
        <div>
          <h1 className="font-display text-[32px] font-medium text-ink">{campaign.name}</h1>
          {campaign.artists && (
            <p className="mt-1.5 font-display text-[15px] italic text-muted-2">{campaign.artists}</p>
          )}
          {campaign.archived_at && <p className="mt-1.5 text-xs text-faint-2">Archived</p>}
        </div>
        <div className="flex items-center gap-4">
          <StatusControl
            campaignId={id}
            status={campaign.status}
            memberCount={memberCount ?? 0}
            hasTestOverride={(templates ?? []).some((t) => t.test_delay_minutes != null)}
          />
          <ArchiveDeleteControls
            campaignId={id}
            campaignName={campaign.name}
            archived={Boolean(campaign.archived_at)}
            memberCount={memberCount ?? 0}
          />
        </div>
      </div>

      <SendControls />

      <section className="mt-11">
        <h2 className="font-display text-[21px] font-medium text-ink">Sequence</h2>
        <p className="mt-1.5 text-pretty text-[13px] text-muted-2">
          Spintext <code className="text-ink-soft">{"{a|b}"}</code> and merge fields{" "}
          <code className="text-ink-soft">{"{{First Name}}"}</code> resolve at send time.
        </p>
        <TemplateEditor campaignId={id} templates={templates ?? []} savedTemplates={savedTemplates ?? []} />
      </section>

      <section className="mt-11">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-[21px] font-medium text-ink">Recipients</h2>
          <span className="text-xs text-muted-3">
            {memberCount ?? 0} total
            {Object.keys(statusCounts).length > 0 &&
              ` — ${Object.entries(statusCounts)
                .map(([k, v]) => `${v} ${k}`)
                .join(", ")}`}
          </span>
        </div>
        <div className="mt-4">
          <RecipientPicker
            campaignId={id}
            lists={lists ?? []}
            segments={segmentOptions}
            campaigns={campaigns ?? []}
          />
        </div>

        <div className="mt-5">
          <div className="grid grid-cols-[1.4fr_1.2fr_1.6fr_0.6fr_1fr_1fr_auto] border-b border-hairline-strong py-2 text-[10px] tracking-wide text-faint uppercase">
            <span>Contact</span>
            <span>Venue</span>
            <span>Email</span>
            <span>Step</span>
            <span>Status</span>
            <span>Last sent</span>
            <span></span>
          </div>
          {(members ?? []).map((m) => {
            const contact = Array.isArray(m.contact) ? m.contact[0] : m.contact;
            return (
              <div
                key={m.id}
                className="grid grid-cols-[1.4fr_1.2fr_1.6fr_0.6fr_1fr_1fr_auto] items-center border-b border-hairline-soft py-2.5 text-[13px]"
              >
                <span className="text-ink">{[contact?.first_name, contact?.last_name].filter(Boolean).join(" ") || "—"}</span>
                <span className="text-muted-2">{contact?.venue ?? "—"}</span>
                <span className="text-muted-2">{contact?.email}</span>
                <span className="text-muted-2">{m.current_step}</span>
                <MemberStatus status={m.member_status} />
                <span className="text-faint-2">
                  {m.last_sent_at ? new Date(m.last_sent_at).toLocaleDateString() : "—"}
                </span>
                <span>{contact?.id && <RemoveMemberButton campaignId={id} contactId={contact.id} />}</span>
              </div>
            );
          })}
          {(members ?? []).length === 0 && (
            <div className="py-8 text-center text-sm text-muted-3">No recipients yet.</div>
          )}
          {(memberCount ?? 0) > MEMBERS_DISPLAY_CAP && (
            <p className="border-t border-hairline py-2.5 text-xs text-faint-3">
              Showing the most recently added {MEMBERS_DISPLAY_CAP} of {memberCount}.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function MemberStatus({ status }: { status: string }) {
  const tone =
    status === "replied"
      ? "text-success"
      : status === "opted_out" || status === "opted out" || status === "bounced"
        ? "text-error"
        : "text-faint-2";
  return <span className={tone}>{status}</span>;
}
