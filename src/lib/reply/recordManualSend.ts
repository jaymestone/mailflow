import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedEmail } from "./types";

/** Records one of Jayme's own messages as thread activity.
 *
 * The reply tick drops his mail before classification in two places: a
 * SENT label, and a from-address belonging to one of the connected
 * accounts (which catches account-to-account mail, where SENT exists only
 * in the sending mailbox). Both drops are right -- his follow-ups were
 * being classified as venue replies and surfacing as phantom leads -- but
 * dropping them entirely left Mailflow with his side of 11 of 458 live
 * threads, so nothing downstream could say whether a deal was waiting on
 * him or on them.
 *
 * This stores the message and nothing else: no classification, no contact
 * matching, no labels, no campaign side effects. It only has to be enough
 * for the conversation pass to know he wrote, when, and what he said.
 *
 * Deliberately never throws. Failing to record his side must not fail the
 * tick that is also ingesting real replies -- the message simply isn't
 * recorded, and the next pass over that thread picks it up.
 */
export async function recordManualSend(
  supabase: SupabaseClient,
  accountId: string,
  email: ParsedEmail,
): Promise<void> {
  try {
    // Mailflow's own campaign sends are in the Sent folder too, and they
    // are not Jayme writing back. Counting them would mark every live
    // thread "awaiting them" the moment a sequence step went out and hide
    // every deal actually waiting on him -- the whole point of capturing
    // his side. The historical backfill pulled 914 of its first 1,000
    // messages from the campaigns before this check existed.
    //
    // Matched on the message id, not the thread: follow-up steps are sent
    // as replies inside the same thread as his manual ones, so excluding
    // by thread would throw away exactly the messages worth keeping.
    const { data: campaignSend } = await supabase
      .from("outbound_sends")
      .select("id")
      .eq("gmail_message_id", email.gmailMessageId)
      .maybeSingle();
    if (campaignSend) return;

    await supabase.from("manual_sends").upsert(
      {
        connected_account_id: accountId,
        gmail_message_id: email.gmailMessageId,
        gmail_thread_id: email.gmailThreadId ?? null,
        from_email: email.fromEmail,
        subject: email.subject ?? null,
        // Capped like the classifier's own input. The gist is written from
        // the opening of each message; keeping a full quoted history per
        // message would multiply row size by the length of the thread.
        body_text: email.bodyText ? email.bodyText.slice(0, 8000) : null,
        sent_at: email.receivedAt,
      },
      { onConflict: "connected_account_id,gmail_message_id", ignoreDuplicates: true },
    );
  } catch {
    // Intentionally swallowed -- see above.
  }
}
