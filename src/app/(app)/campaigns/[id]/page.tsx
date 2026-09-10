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
    { count: activeCount },
    { count: pausedCount },
    { count: completedCount },
    { data: replies },
    { data: clicks },
    { data: sendEngineHealth },
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
    // Per-status counts via real COUNT queries, not fetch-every-row-and-
    // count-in-JS -- the latter silently undercounts past Supabase's
    // default 1000-row response cap once a campaign has more than 1000
    // members (confirmed live: a 4,261-member campaign showed exactly
    // 1,000 "active" and 0 paused/completed, rather than the true mix).
    supabase
      .from("campaign_members")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id)
      .eq("member_status", "active"),
    supabase
      .from("campaign_members")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id)
      .eq("member_status", "paused"),
    supabase
      .from("campaign_members")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id)
      .eq("member_status", "completed"),
    supabase
      .from("inbound_messages")
      .select("classification_category")
      .eq("matched_campaign_id", id)
      .eq("message_type", "reply"),
    // Joined via link_tokens' own campaign_id rather than fetching every
    // token for this campaign and passing thousands of ids through .in() --
    // the same payload-size mistake already fixed once elsewhere in this
    // app. Real (non-bot) clicks only; a campaign this size realistically
    // has dozens-to-low-hundreds of clicks, not thousands, so grouping by
    // label and by contact in JS afterward is cheap.
    supabase
      .from("link_clicks")
      .select("token, link_tokens!inner(label, contact_id, campaign_id)")
      .eq("link_tokens.campaign_id", id)
      .eq("is_likely_bot", false),
    // The send engine's own heartbeat -- account-wide, not specific to this
    // campaign (there's only one engine), shown so "Send now" doesn't read
    // as the only thing making a campaign send. See send-controls.tsx.
    supabase.from("cron_health").select("last_run_at").eq("job_name", "send-engine-tick").maybeSingle(),
  ]);

  const segmentOptions = (segments ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    count: Array.isArray(s.saved_segment_contacts) ? (s.saved_segment_contacts[0]?.count ?? 0) : 0,
  }));

  const statusCounts = { active: activeCount ?? 0, paused: pausedCount ?? 0, completed: completedCount ?? 0 };

  // Same fix as the status counts above, applied per step: a real COUNT
  // per step_number rather than fetching every outbound_sends row for the
  // campaign and grouping in JS, which would hit the same 1000-row cap
  // once a campaign's total sends across all steps pass that mark.
  const sentByStep: Record<number, number> = {};
  await Promise.all(
    (templates ?? []).map(async (t) => {
      const { count } = await supabase
        .from("outbound_sends")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", id)
        .eq("status", "sent")
        .eq("step_number", t.step_number);
      sentByStep[t.step_number] = count ?? 0;
    }),
  );

  const replyCounts: Record<string, number> = {};
  for (const r of replies ?? []) {
    const category = r.classification_category ?? "uncategorized";
    replyCounts[category] = (replyCounts[category] ?? 0) + 1;
  }

  const clickRows = (clicks ?? []).map((c) => {
    const linkToken = Array.isArray(c.link_tokens) ? c.link_tokens[0] : c.link_tokens;
    return { label: linkToken?.label ?? "Unknown link", contactId: linkToken?.contact_id ?? null };
  });
  const clicksByLabel: Record<string, number> = {};
  for (const c of clickRows) {
    clicksByLabel[c.label] = (clicksByLabel[c.label] ?? 0) + 1;
  }
  const uniqueClickers = new Set(clickRows.map((c) => c.contactId).filter(Boolean)).size;
  const topClickedLabels = Object.entries(clicksByLabel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

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

      <SendControls lastEngineRunAt={sendEngineHealth?.last_run_at ?? null} />

      <section className="mt-9 rounded-[3px] border border-hairline bg-surface p-5">
        <h2 className="font-display text-[21px] font-medium text-ink">Status</h2>

        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
          <Stat label="Total recipients" value={memberCount ?? 0} />
          <Stat label="Active" value={statusCounts.active ?? 0} />
          <Stat label="Paused" value={statusCounts.paused ?? 0} />
          <Stat label="Completed" value={statusCounts.completed ?? 0} />
        </div>

        {(templates ?? []).length > 0 && (
          <div className="mt-6">
            <h3 className="text-[10px] tracking-wide text-faint uppercase">Sent, by step</h3>
            <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
              {(templates ?? []).map((t) => (
                <div key={t.step_number} className="text-[13px]">
                  <span className="text-ink">{sentByStep[t.step_number] ?? 0}</span>
                  <span className="text-muted-3"> sent step {t.step_number}</span>
                  <span className="ml-1.5 text-faint-3">
                    ({(memberCount ?? 0) - (sentByStep[t.step_number] ?? 0)} not sent yet — includes anyone paused
                    or not yet due, not only what's queued)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6">
          <h3 className="text-[10px] tracking-wide text-faint uppercase">Replies</h3>
          {Object.keys(replyCounts).length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
              {Object.entries(replyCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([category, count]) => (
                  <span key={category}>
                    <span className="text-ink">{count}</span>{" "}
                    <span className="text-muted-3">{category.replace(/_/g, " ")}</span>
                  </span>
                ))}
            </div>
          ) : (
            <p className="mt-1.5 text-[13px] text-faint-3">No replies yet.</p>
          )}
        </div>

        <div className="mt-6">
          <h3 className="text-[10px] tracking-wide text-faint uppercase">Link clicks</h3>
          {clickRows.length > 0 ? (
            <>
              <p className="mt-1.5 text-[13px] text-ink-soft">
                <span className="text-ink">{clickRows.length}</span> clicks from{" "}
                <span className="text-ink">{uniqueClickers}</span> contact{uniqueClickers === 1 ? "" : "s"}
              </p>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
                {topClickedLabels.map(([label, count]) => (
                  <span key={label}>
                    <span className="text-ink">{count}</span> <span className="text-muted-3">{label}</span>
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-1.5 text-[13px] text-faint-3">No clicks yet.</p>
          )}
          <p className="mt-2 text-[11px] text-faint-3">
            No open-rate tracking here on purpose — pixel-based open tracking has gotten unreliable across major
            clients (Apple Mail and Gmail both pre-fetch images regardless of whether anyone actually opened the
            email), so it mostly measures noise. Clicks are a real signal; opens mostly aren&apos;t anymore.
          </p>
        </div>
      </section>

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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-display text-[26px] font-medium text-ink">{value.toLocaleString()}</div>
      <div className="text-[10px] tracking-wide text-faint uppercase">{label}</div>
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
