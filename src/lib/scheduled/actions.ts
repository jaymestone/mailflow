import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "@/lib/gmail/client";

// Scheduled actions: one-off jobs Jayme wants done at a set time ("send these
// Gmail drafts Monday morning", "start this campaign then", "un-pause these
// 12 on Oct 29 unless they replied"). Mailflow has no start date on a
// campaign, and Gmail's API can't schedule a send, so this runner does it.
//
// Stored as one JSON array in app_settings (key below) — no migration — and
// run from the 15-minute reconcile tick, so it needs no cron job of its own.
// Every action is safe to run twice: a sent draft is gone from Drafts, an
// active campaign stays active, an active member stays active.

export const SCHEDULED_ACTIONS_KEY = "scheduled_actions";

export type ScheduledAction = {
  id: string;
  label: string;
  runAt: string; // ISO timestamp
  status: "pending" | "done" | "failed";
  createdAt: string;
  doneAt?: string;
  result?: unknown;
} & (
  | { type: "send_gmail_drafts"; params: { account: string; draftIds: string[]; requireRemoved?: string } }
  | { type: "activate_campaign"; params: { campaignId: string } }
  | { type: "unpause_members"; params: { campaignId: string; contactIds?: string[]; skipIfRepliedSince?: string } }
);

/** Pending actions whose time has come, oldest first. */
export function dueActions(actions: ScheduledAction[], now: Date): ScheduledAction[] {
  return actions
    .filter((a) => a.status === "pending" && Date.parse(a.runAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
}

// requireRemoved: an approval line written at the top of each draft. Only
// drafts where Jayme deleted it get sent; the rest stay in Drafts untouched.
// Any failure to read the draft (rate limit, 5xx) throws, and the draft is
// NOT sent: on Oct 19 a 403 on this read returned an error body with no
// text, the line looked "removed", and two unapproved drafts went out.
async function draftText(token: string, id: string): Promise<string | null> {
  let r: Response | undefined;
  for (let k = 0; k < 4; k++) {
    r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return null;
    if (r.ok) break;
    await new Promise((x) => setTimeout(x, 1500 * (k + 1)));
  }
  if (!r?.ok) throw new Error(`read ${r?.status}`);
  const d = await r.json();
  if (!d.message?.payload) throw new Error("read: no payload");
  const parts: string[] = [];
  const walk = (p: any) => { if (p?.body?.data) parts.push(Buffer.from(p.body.data, "base64url").toString("utf8")); for (const c of p?.parts || []) walk(c); };
  walk(d.message?.payload);
  return parts.join("\n");
}

// deadline (epoch ms): stop starting new drafts after it and report
// partial, so a big batch spans several 15-minute ticks instead of being
// killed by the 60s function limit (Oct 19: the 11am batch never finished).
// Re-running is safe — sent drafts are gone (404).
export async function sendDrafts(supabase: SupabaseClient, account: string, draftIds: string[], requireRemoved?: string, deadline = Infinity) {
  const { data: acct } = await supabase.from("connected_accounts").select("id").eq("email_address", account).single();
  if (!acct) throw new Error(`no connected account ${account}`);
  const token = await getAccessToken(supabase, acct.id);
  const out = { sent: 0, gone: 0, notApproved: 0, failed: [] as string[], partial: false };
  for (const id of draftIds) {
    if (Date.now() > deadline) { out.partial = true; break; }
    if (requireRemoved) {
      let text: string | null;
      try { text = await draftText(token, id); } catch (e) { out.failed.push(`${id}: ${e instanceof Error ? e.message : e} (not sent)`); continue; }
      if (text === null) { out.gone++; continue; }
      if (!text.trim() || text.includes(requireRemoved)) { out.notApproved++; continue; }
    }
    // Pace sends: Gmail 403s a burst (45 of 99 on Oct 19).
    await new Promise((x) => setTimeout(x, 1200));
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) out.sent++;
    else if (res.status === 404) out.gone++; // already sent (or deleted) by Jayme
    else out.failed.push(`${id}: ${res.status}`);
  }
  return out;
}

async function unpause(supabase: SupabaseClient, p: { campaignId: string; contactIds?: string[]; skipIfRepliedSince?: string }) {
  let q = supabase.from("campaign_members").select("id,contact_id").eq("campaign_id", p.campaignId).eq("member_status", "paused");
  if (p.contactIds?.length) q = q.in("contact_id", p.contactIds);
  const { data: members } = await q;
  const ids = (members || []).map((m) => m.contact_id);
  let replied = new Set<string>();
  if (p.skipIfRepliedSince && ids.length) {
    const { data: inb } = await supabase
      .from("inbound_messages")
      .select("matched_contact_id,classification_category")
      .in("matched_contact_id", ids)
      .gte("received_at", p.skipIfRepliedSince);
    replied = new Set((inb || []).filter((x) => !/bounce|ooo|auto/.test(x.classification_category || "")).map((x) => x.matched_contact_id));
  }
  const resume = (members || []).filter((m) => !replied.has(m.contact_id)).map((m) => m.id);
  if (resume.length) await supabase.from("campaign_members").update({ member_status: "active" }).in("id", resume);
  return { resumed: resume.length, keptPausedBecauseReplied: replied.size };
}

export async function runScheduledActions(supabase: SupabaseClient, now = new Date(), budgetMs = 40_000) {
  const deadline = Date.now() + budgetMs;
  const { data: row } = await supabase.from("app_settings").select("value").eq("key", SCHEDULED_ACTIONS_KEY).maybeSingle();
  const actions: ScheduledAction[] = Array.isArray(row?.value) ? (row!.value as ScheduledAction[]) : [];
  const due = dueActions(actions, now);
  if (!due.length) return { due: 0 };

  const ran: { id: string; label: string; status: string }[] = [];
  for (const a of due) {
    if (Date.now() > deadline) break; // the rest wait for the next tick
    let partial = false;
    try {
      if (a.type === "send_gmail_drafts") {
        const r = await sendDrafts(supabase, a.params.account, a.params.draftIds, a.params.requireRemoved, deadline);
        partial = r.partial;
        a.result = r;
      } else if (a.type === "activate_campaign") {
        const { error } = await supabase.from("campaigns").update({ status: "active" }).eq("id", a.params.campaignId);
        if (error) throw error;
        a.result = { activated: a.params.campaignId };
      } else if (a.type === "unpause_members") a.result = await unpause(supabase, a.params);
      a.status = partial ? "pending" : "done";
    } catch (err) {
      a.status = "failed";
      a.result = { error: err instanceof Error ? err.message : String(err) };
    }
    if (a.status !== "pending") a.doneAt = new Date().toISOString();
    ran.push({ id: a.id, label: a.label, status: partial ? "partial" : a.status });
    await save(supabase, a); // persist each one, so a timeout can't lose finished work
  }
  return { due: due.length, ran };
}

// Re-read before writing so an action added while this ran isn't lost.
async function save(supabase: SupabaseClient, a: ScheduledAction) {
  const { data: fresh } = await supabase.from("app_settings").select("value").eq("key", SCHEDULED_ACTIONS_KEY).maybeSingle();
  const latest: ScheduledAction[] = Array.isArray(fresh?.value) ? (fresh!.value as ScheduledAction[]) : [];
  await supabase.from("app_settings").upsert({ key: SCHEDULED_ACTIONS_KEY, value: latest.map((x) => (x.id === a.id ? a : x)) }, { onConflict: "key" });
}
