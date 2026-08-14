import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TemplateEditor } from "./template-editor";
import { StatusControl, AddRecipientsForm, RemoveMemberButton } from "./campaign-controls";

const MEMBERS_DISPLAY_CAP = 200;

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: campaign } = await supabase.from("campaigns").select("*").eq("id", id).single();
  if (!campaign) notFound();

  const [{ data: templates }, { data: lists }, { data: members }, { count: memberCount }] = await Promise.all([
    supabase.from("campaign_templates").select("*").eq("campaign_id", id).order("step_number"),
    supabase.from("lists").select("id, name").order("name"),
    supabase
      .from("campaign_members")
      .select("id, current_step, member_status, last_sent_at, contact:contacts(id, first_name, last_name, email, venue)")
      .eq("campaign_id", id)
      .order("added_at", { ascending: false })
      .limit(MEMBERS_DISPLAY_CAP),
    supabase.from("campaign_members").select("id", { count: "exact", head: true }).eq("campaign_id", id),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const m of members ?? []) {
    statusCounts[m.member_status] = (statusCounts[m.member_status] ?? 0) + 1;
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-balance text-2xl font-semibold">{campaign.name}</h1>
          {campaign.artists && <p className="mt-1 text-sm text-neutral-400">{campaign.artists}</p>}
        </div>
        <StatusControl campaignId={id} status={campaign.status} />
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Sequence</h2>
        <p className="mt-1 text-pretty text-sm text-neutral-400">
          Spintext <code className="text-neutral-300">{"{a|b}"}</code> and merge fields{" "}
          <code className="text-neutral-300">{"{{First Name}}"}</code> resolve at send time.
        </p>
        <TemplateEditor campaignId={id} templates={templates ?? []} />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Recipients</h2>
        <p className="mt-1 text-sm text-neutral-400">
          {memberCount ?? 0} total
          {Object.keys(statusCounts).length > 0 &&
            ` — ${Object.entries(statusCounts)
              .map(([k, v]) => `${v} ${k}`)
              .join(", ")}`}
        </p>
        <div className="mt-3">
          <AddRecipientsForm campaignId={id} lists={lists ?? []} />
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">Contact</th>
                <th className="px-3 py-2">Venue</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Step</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last sent</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(members ?? []).map((m) => {
                const contact = Array.isArray(m.contact) ? m.contact[0] : m.contact;
                return (
                  <tr key={m.id} className="border-b border-neutral-900">
                    <td className="px-3 py-2 text-neutral-100">
                      {[contact?.first_name, contact?.last_name].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="px-3 py-2 text-neutral-400">{contact?.venue ?? "—"}</td>
                    <td className="px-3 py-2 text-neutral-400">{contact?.email}</td>
                    <td className="px-3 py-2 text-neutral-400">{m.current_step}</td>
                    <td className="px-3 py-2 text-neutral-400">{m.member_status}</td>
                    <td className="px-3 py-2 text-neutral-500">
                      {m.last_sent_at ? new Date(m.last_sent_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {contact?.id && <RemoveMemberButton campaignId={id} contactId={contact.id} />}
                    </td>
                  </tr>
                );
              })}
              {(members ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-neutral-500">
                    No recipients yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {(memberCount ?? 0) > MEMBERS_DISPLAY_CAP && (
            <p className="border-t border-neutral-800 px-3 py-2 text-xs text-neutral-500">
              Showing the most recently added {MEMBERS_DISPLAY_CAP} of {memberCount}.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
