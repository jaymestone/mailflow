import { createClient } from "@/lib/supabase/server";
import { PollNowButton, CategorySelect } from "./inbox-client";

const CATEGORY_TONES: Record<string, string> = {
  interested: "text-emerald-400",
  not_interested: "text-neutral-500",
  follow_up: "text-amber-400",
  ooo: "text-neutral-500",
  opt_out: "text-red-400",
  bounce: "text-red-400",
  unclear: "text-neutral-400",
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("inbound_messages")
    .select(
      "id, from_email, from_name, subject, body_text, received_at, classification_category, match_method, gmail_thread_id, campaign:campaigns(name)",
    )
    .eq("message_type", "reply")
    .order("received_at", { ascending: false })
    .limit(200);

  if (params.category) query = query.eq("classification_category", params.category);

  const { data: messages } = await query;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-balance text-2xl font-semibold">Inbox</h1>
        <PollNowButton />
      </div>
      <p className="mt-2 text-pretty text-sm text-neutral-400">
        Replies sorted by intent. Polls automatically every 5 minutes.
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <a
          href="/inbox"
          className={`rounded-full px-3 py-1 ${!params.category ? "bg-neutral-50 text-neutral-950" : "bg-neutral-900 text-neutral-400"}`}
        >
          All
        </a>
        {Object.keys(CATEGORY_TONES).map((c) => (
          <a
            key={c}
            href={`/inbox?category=${c}`}
            className={`rounded-full px-3 py-1 capitalize ${params.category === c ? "bg-neutral-50 text-neutral-950" : "bg-neutral-900 text-neutral-400"}`}
          >
            {c.replace("_", " ")}
          </a>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {(messages ?? []).map((m) => {
          const campaign = Array.isArray(m.campaign) ? m.campaign[0] : m.campaign;
          return (
            <div key={m.id} className="rounded-lg border border-neutral-800 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-neutral-100">
                    {m.from_name ?? m.from_email} <span className="text-neutral-500">&lt;{m.from_email}&gt;</span>
                  </div>
                  <div className="mt-0.5 text-sm text-neutral-300">{m.subject}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`text-xs capitalize ${CATEGORY_TONES[m.classification_category ?? "unclear"]}`}>
                    {(m.classification_category ?? "unclear").replace("_", " ")}
                  </span>
                  <CategorySelect id={m.id} category={m.classification_category} />
                </div>
              </div>
              <p className="mt-2 line-clamp-3 text-xs text-neutral-500">{m.body_text}</p>
              <div className="mt-2 flex items-center gap-3 text-xs text-neutral-600">
                <span>{new Date(m.received_at).toLocaleString()}</span>
                {campaign?.name && <span>· {campaign.name}</span>}
                <span>· matched via {m.match_method}</span>
                {m.gmail_thread_id && (
                  <a
                    href={`https://mail.google.com/mail/u/0/#all/${m.gmail_thread_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-neutral-400 hover:underline"
                  >
                    Open in Gmail
                  </a>
                )}
              </div>
            </div>
          );
        })}
        {(messages ?? []).length === 0 && (
          <p className="py-8 text-center text-sm text-neutral-500">No replies yet.</p>
        )}
      </div>
    </div>
  );
}
