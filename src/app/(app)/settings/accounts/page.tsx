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
    .select("id, email_address, can_send, status, last_error, ramp_schedule")
    .order("email_address");

  const { data: replyToSetting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "reply_to_account_id")
    .single();
  const replyToAccountId = replyToSetting?.value ?? null;

  return (
    <div>
      <h1 className="text-balance text-2xl font-semibold">Connected accounts</h1>
      <p className="mt-2 text-pretty text-sm text-neutral-400">
        Connect 4-6 Gmail accounts to send from on a rotation, respecting each account&apos;s daily
        cap and ramp-up schedule. Pick one as the Reply-To address that receives human replies.
      </p>

      {params.oauth === "success" && (
        <p className="mt-4 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
          Connected {params.detail}.
        </p>
      )}
      {params.oauth === "error" && (
        <p className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
          Connection failed: {params.detail}
        </p>
      )}

      <a
        href="/api/oauth/google/connect"
        className="mt-4 inline-block rounded-lg bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
      >
        Connect Gmail account
      </a>

      <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Ramp schedule</th>
              <th className="px-3 py-2">Sending</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {(accounts ?? []).map((a) => (
              <AccountRow key={a.id} account={a} isReplyTo={a.id === replyToAccountId} />
            ))}
            {(accounts ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-neutral-500">
                  No accounts connected yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
