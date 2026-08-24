import { createClient } from "@/lib/supabase/server";
import { AccountRow } from "./accounts-client";

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string; detail?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();

  const { data: accounts } = await supabase
    .from("connected_accounts")
    .select("id, email_address, display_name, can_send, status, last_error, ramp_schedule")
    .order("email_address");

  const { data: replyToSetting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "reply_to_account_id")
    .single();
  const replyToAccountId = replyToSetting?.value ?? null;

  return (
    <div>
      <h1 className="font-display text-[32px] font-medium text-ink">Sending accounts</h1>
      <p className="mt-2 max-w-[62ch] text-pretty text-sm text-muted">
        Connected mailboxes, ramp schedules, and reply-to routing. Connect 4-6 Gmail accounts to
        send from on a rotation, each respecting its own daily cap and ramp-up schedule.
      </p>

      {params.oauth === "success" && (
        <p className="mt-4 rounded-[2px] bg-success-bg px-3.5 py-2.5 text-sm text-success">
          Connected {params.detail}.
        </p>
      )}
      {params.oauth === "error" && (
        <p className="mt-4 rounded-[2px] bg-error-bg px-3.5 py-2.5 text-sm text-error">
          Connection failed: {params.detail}
        </p>
      )}

      <a
        href="/api/oauth/google/connect"
        className="mt-4 inline-block rounded-[2px] bg-ink px-4 py-2.5 text-sm font-semibold text-surface no-underline"
      >
        Connect Gmail account
      </a>

      <div className="mt-7 flex flex-col gap-3.5">
        {(accounts ?? []).map((a) => (
          <AccountRow key={a.id} account={a} isReplyTo={a.id === replyToAccountId} />
        ))}
        {(accounts ?? []).length === 0 && (
          <div className="py-8 text-center text-sm text-muted-3">No accounts connected yet.</div>
        )}
      </div>
    </div>
  );
}
