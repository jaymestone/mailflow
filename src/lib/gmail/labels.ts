import type { ReplyCategory } from "@/lib/reply/types";

/** Plain category names, not namespaced under "Mailflow/" — several
 * accounts already had labels with these exact names from the prior N8N
 * workflow, and reusing them avoids a duplicate label per category sitting
 * alongside the one Jayme already reads from. Applied directly in Gmail
 * (not just shown inside Mailflow's own Inbox page) since replies are
 * actually read in Gmail itself, not this app. */
export const CATEGORY_LABEL_NAMES: Record<ReplyCategory, string> = {
  interested: "Interested",
  not_interested: "Not Interested",
  follow_up: "Follow Up",
  ooo_temporary: "Out of Office",
  ooo_departed: "Departed",
  opt_out: "Opted Out",
  bounce: "Bounce",
  unclear: "Unclear",
  // NOT "Spam". Gmail reserves SPAM as a system label and refuses to
  // create a user label whose name matches one, case-insensitively, so
  // every lead-gen message classified here failed to label and stayed
  // stuck -- six of them across 2026-10-02..04, regenerating the health
  // alert every four hours with no path to recovery, because a message
  // only gets a label retry if Gmail's history happens to re-offer it.
  //
  // Renaming rather than binding the category to the system SPAM label:
  // applying that would move the mail into the Spam folder and train
  // Gmail's filter, which is a different behaviour from what this does
  // today (archive it, label it, leave Gmail's own verdict alone -- see
  // applyCategoryLabel). The name also says what spam.ts actually
  // detects, which is cold lead-gen mail, not spam in general.
  spam: "Lead-Gen Spam",
};

type GmailLabel = { id: string; name: string; type?: string };

/** Labels are per-mailbox in Gmail, so each connected account needs its own
 * copy of each "Mailflow/…" label the first time it's used. `cache` is
 * shared across a whole poll tick, keyed by "accountId:labelName", so
 * listing an account's labels happens at most once per tick rather than
 * once per message. */
export async function getOrCreateLabelId(
  accessToken: string,
  accountId: string,
  labelName: string,
  cache: Map<string, string>,
): Promise<string> {
  // Keyed case-insensitively: Gmail matches label names that way when
  // deciding whether a name is taken, so treating "Follow Up" and
  // "follow up" as different here would mean asking it to create a label
  // it will always refuse.
  const key = (name: string) => `${accountId}:${name.toLowerCase()}`;

  const cached = cache.get(key(labelName));
  if (cached) return cached;

  const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error(`Gmail list labels failed: ${listRes.status} ${await listRes.text()}`);
  const { labels } = (await listRes.json()) as { labels?: GmailLabel[] };

  // Cache every Mailflow label already present on this account, not just
  // the one asked for — avoids a repeat list call for the next category.
  //
  // System labels are skipped on purpose. Matching case-insensitively is
  // what lets a differently-cased existing label be reused, but it would
  // also let a category silently bind to one of Gmail's own labels, and
  // applying SPAM or TRASH to a message moves it rather than tagging it.
  // A category must only ever resolve to a label this app owns.
  const wanted = new Set(Object.values(CATEGORY_LABEL_NAMES).map((n) => n.toLowerCase()));
  for (const label of labels ?? []) {
    if (label.type === "system") continue;
    if (wanted.has(label.name.toLowerCase())) cache.set(key(label.name), label.id);
  }

  const found = cache.get(key(labelName));
  if (found) return found;

  const createRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    // 409 means the name is taken by something this app cannot use --
    // in practice a reserved system label, since any user label would
    // have been found above. Say so plainly: the raw Gmail body for this
    // reads "Label name exists or conflicts", which gives no hint that
    // the fix is to rename the category rather than retry it, and the
    // failure otherwise surfaces only as a message stuck unlabelled.
    if (createRes.status === 409) {
      throw new Error(
        `Gmail refuses the label name "${labelName}" on account ${accountId} -- it collides with a reserved system label. ` +
          `Rename this category in CATEGORY_LABEL_NAMES; retrying cannot succeed.`,
      );
    }
    throw new Error(`Gmail create label "${labelName}" failed: ${createRes.status} ${body}`);
  }
  const created = (await createRes.json()) as GmailLabel;
  cache.set(key(labelName), created.id);
  return created.id;
}

export async function applyGmailLabel(
  accessToken: string,
  messageId: string,
  labelId: string,
  removeLabelIds?: string[],
): Promise<void> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId], ...(removeLabelIds ? { removeLabelIds } : {}) }),
  });
  if (!res.ok) throw new Error(`Gmail apply label failed: ${res.status} ${await res.text()}`);
}
