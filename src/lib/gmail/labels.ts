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
};

type GmailLabel = { id: string; name: string };

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
  const key = (name: string) => `${accountId}:${name}`;

  const cached = cache.get(key(labelName));
  if (cached) return cached;

  const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error(`Gmail list labels failed: ${listRes.status} ${await listRes.text()}`);
  const { labels } = (await listRes.json()) as { labels?: GmailLabel[] };

  // Cache every Mailflow label already present on this account, not just
  // the one asked for — avoids a repeat list call for the next category.
  for (const label of labels ?? []) {
    if (Object.values(CATEGORY_LABEL_NAMES).includes(label.name)) {
      cache.set(key(label.name), label.id);
    }
  }

  const found = cache.get(key(labelName));
  if (found) return found;

  const createRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  if (!createRes.ok) throw new Error(`Gmail create label "${labelName}" failed: ${createRes.status} ${await createRes.text()}`);
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
