import { createClient } from "@/lib/supabase/server";
import { PollNowButton, CategorySelect } from "./inbox-client";

const CATEGORY_TONES: Record<string, string> = {
  interested: "text-success",
  not_interested: "text-faint",
  follow_up: "text-warning",
  ooo_temporary: "text-faint",
  ooo_departed: "text-error",
  opt_out: "text-error",
  bounce: "text-error",
  unclear: "text-muted-2",
};

// Temporary OOO auto-replies are handled automatically (sequence just
// pauses and resumes on the contact's return date) — they're excluded from
// the default "All" view so they don't bury replies that actually need
// attention. Still fully visible via the "ooo temporary" filter pill, and
// in a contact's history.
const AUTO_HANDLED_CATEGORIES = ["ooo_temporary"];

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

  if (params.category) {
    query = query.eq("classification_category", params.category);
  } else {
    query = query.not("classification_category", "in", `(${AUTO_HANDLED_CATEGORIES.join(",")})`);
  }

  const { data: messages } = await query;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-[32px] font-medium text-ink">Inbox</h1>
        <PollNowButton />
      </div>
      <p className="mt-2 text-pretty text-sm text-muted">
        Replies pulled from every connected sending account.
      </p>

      <div className="mt-5 flex flex-wrap gap-2 text-xs">
        <a
          href="/inbox"
          className={`rounded-full border px-3 py-1 no-underline ${
            !params.category ? "border-ink bg-ink text-surface" : "border-hairline-strong text-muted-3"
          }`}
        >
          All
        </a>
        {Object.keys(CATEGORY_TONES).map((c) => (
          <a
            key={c}
            href={`/inbox?category=${c}`}
            className={`rounded-full border px-3 py-1 capitalize no-underline ${
              params.category === c ? "border-ink bg-ink text-surface" : "border-hairline-strong text-muted-3"
            }`}
          >
            {c.replace("_", " ")}
          </a>
        ))}
      </div>

      <div className="mt-3">
        {(messages ?? []).map((m) => {
          const campaign = Array.isArray(m.campaign) ? m.campaign[0] : m.campaign;
          return (
            <div
              key={m.id}
              className="grid grid-cols-[1.4fr_3fr_1fr] items-start gap-5 border-b border-hairline py-[18px]"
            >
              <div>
                <span className="block font-display text-base text-ink">{m.from_name ?? m.from_email}</span>
                <span className="text-xs text-faint">{m.from_email}</span>
              </div>
              <div>
                <span className="block text-sm font-semibold text-ink">{m.subject}</span>
                <span className="line-clamp-2 text-[13px] text-muted-2">{m.body_text}</span>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-faint-3">
                  <span>{new Date(m.received_at).toLocaleString()}</span>
                  {campaign?.name && <span>· {campaign.name}</span>}
                  <span>· matched via {m.match_method}</span>
                  {m.gmail_thread_id && (
                    <a
                      href={`https://mail.google.com/mail/u/0/#all/${m.gmail_thread_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent"
                    >
                      Open in Gmail
                    </a>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="flex flex-col items-end gap-1.5">
                  <span className={`text-[11px] capitalize ${CATEGORY_TONES[m.classification_category ?? "unclear"]}`}>
                    {(m.classification_category ?? "unclear").replace("_", " ")}
                  </span>
                  <CategorySelect id={m.id} category={m.classification_category} />
                </div>
              </div>
            </div>
          );
        })}
        {(messages ?? []).length === 0 && (
          <p className="py-8 text-center text-sm text-muted-3">No replies yet.</p>
        )}
      </div>
    </div>
  );
}
