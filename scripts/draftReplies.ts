// Draft replies, in Jayme's voice, to venue replies waiting on him — written
// as Gmail drafts in the existing stone@ thread, never sent. Each draft opens
// with an approval line; the Monday scheduled send only sends drafts where
// Jayme deleted that line (see send_gmail_drafts' requireRemoved).
//
//   npx tsx --env-file=.env.local scripts/draftReplies.ts --days 7 [--limit N] [--dry]
//
// Writes the created draft ids to .draft-replies.json.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { getAccessToken, encodeHeaderWord } from "../src/lib/gmail/client";
import { systemPrompt, examplesFor } from "../src/lib/drafting/prompt";

export const APPROVE_LINE = "▶ DELETE THIS LINE TO APPROVE FOR MONDAY";
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const args = process.argv.slice(2);
const days = Number(args[args.indexOf("--days") + 1] || 7);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const dry = args.includes("--dry");
// --followups: threads where Jayme wrote last more than --days ago with no
// answer; drafts a short check-in instead of a reply.
const followups = args.includes("--followups");
// --catchup: same selection as --followups, but drafts REPLIES for the threads
// where Gmail shows the venue actually wrote last (Mailflow still has Jayme
// last). --exclude "Name,Name" leaves venues out by name.
const catchup = args.includes("--catchup");
// --venues "a,b": only conversations whose venue contains one of these.
const onlyVenues = (args.includes("--venues") ? args[args.indexOf("--venues") + 1] : "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const exclude = new Set((args.includes("--exclude") ? args[args.indexOf("--exclude") + 1] : "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
const OWN = /@jaymestone(agency)?\.com$|@followupthen\.com$|^noreply@|^no-reply@/i; // Jayme's own addresses + his reminder service

const SYSTEM = systemPrompt();

type Msg = { from: string; to: string; cc: string; date: string; subject: string; messageId: string; references: string; text: string };
const header = (m: any, n: string) => (m.payload.headers || []).find((h: any) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
const plain = (p: any): string => { if (!p) return ""; if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8"); for (const c of p.parts || []) { const t = plain(c); if (t) return t; } return ""; };
const addrs = (v: string) => (v.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map((a) => a.toLowerCase());
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toText = (b: string) => b.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 <$2>");
const toHtml = (b: string) => b.split(/\n{2,}/).map((p) => `<div>${esc(p).replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>').replace(/\n/g, "<br>")}</div>`).join("<div><br></div>");
const SIG = "Kindly,\n\n◙◙◙   Jayme Stone\n◙◙◙   303.495.0989\n◙◙◙   jaymestone.com\n◙◙◙   instigator / integrator";
const SIG_HTML = 'Kindly,<br><br>◙◙◙&nbsp;&nbsp; Jayme Stone<br>◙◙◙&nbsp;&nbsp; 303.495.0989<br>◙◙◙&nbsp;&nbsp; <a href="https://www.jaymestone.com">jaymestone.com</a><br>◙◙◙&nbsp;&nbsp; instigator / integrator';

async function gmail(token: string, path: string, init?: RequestInit) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(`Gmail ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

(async () => {
  const { data: acct } = await supabase.from("connected_accounts").select("id").eq("email_address", "stone@jaymestone.com").single();
  const token = await getAccessToken(supabase, acct!.id);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  let cq = supabase.from("conversations").select("id,venue,artist,status,status_override,thread_key,gmail_thread_ids,last_message_at,contact_id,contacts(email)").eq("is_live", true);
  cq = followups || catchup ? cq.eq("last_direction", "outbound").lt("last_message_at", since) : cq.eq("last_direction", "inbound").gte("last_message_at", since);
  const { data: convs } = await cq.order("last_message_at", { ascending: false });
  let todo = (convs || []).filter((c) => !/@jaymestone(agency)?\.com::/.test(c.thread_key) && (c.status_override || c.status) !== "parked");
  todo = todo.filter((c: any) => !exclude.has(String(c.venue || "").toLowerCase()));
  if (onlyVenues.length) todo = todo.filter((c: any) => onlyVenues.some((v) => String(c.venue || "").toLowerCase().includes(v)));
  if (followups) {
    // Don't stack a check-in on top of a campaign email this venue just got or is about to get.
    const GEN = /@(gmail|yahoo|hotmail|aol|outlook|icloud|comcast|me|msn|live|mac|earthlink|sbcglobal|att|bellsouth)\./i;
    const org = (e: string) => (GEN.test(e) ? e.toLowerCase() : e.split("@")[1]?.toLowerCase());
    const { data: camps } = await supabase.from("campaigns").select("id,status");
    const live = (camps || []).filter((x) => x.status === "active" || x.status === "draft").map((x) => x.id);
    const { data: mem } = await supabase.from("campaign_members").select("contact_id,member_status,current_step,last_sent_at,added_at,contacts(email)").in("campaign_id", live).gte("added_at", new Date(Date.now() - 21 * 864e5).toISOString());
    const busy = new Set((mem || []).map((m: any) => org(m.contacts?.email || "")).filter(Boolean));
    const before = todo.length;
    todo = todo.filter((c: any) => !busy.has(org(c.contacts?.email || String(c.thread_key).split("::")[0])));
    console.log(`${before - todo.length} skipped: in a campaign added in the last 3 weeks`);
  }
  todo = todo.slice(0, limit);

  // Threads that already have a draft in stone@ are left alone.
  const drafted = new Set<string>();
  let pageToken = "";
  do { const d = await gmail(token, `drafts?maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`); for (const x of d.drafts || []) drafted.add(x.message.threadId); pageToken = d.nextPageToken || ""; } while (pageToken);

  const out: { venue: string; draftId?: string; threadId?: string; needsYou?: string; skipped?: string; body?: string; createdAt?: string }[] = [];
  await pool(todo, args.includes("--slow") ? 2 : 6, async (c) => {
    try {
      const ids: string[] = c.gmail_thread_ids || [];
      const { data: inb } = await supabase.from("inbound_messages").select("gmail_thread_id,received_at").eq("connected_account_id", acct!.id).in("gmail_thread_id", ids).order("received_at", { ascending: false }).limit(1);
      const threadId = inb?.[0]?.gmail_thread_id;
      if (!threadId) { out.push({ venue: c.venue, skipped: "no stone@ thread" }); return; }
      if (drafted.has(threadId)) { out.push({ venue: c.venue, skipped: "already has a draft" }); return; }
      const t = await gmail(token, `threads/${threadId}?format=full`);
      const msgs: Msg[] = t.messages.map((m: any) => ({ from: header(m, "From"), to: header(m, "To"), cc: header(m, "Cc"), date: header(m, "Date"), subject: header(m, "Subject"), messageId: header(m, "Message-ID"), references: header(m, "References"), text: plain(m.payload).split(/\r?\nOn [^\n]{5,120}wrote:|\r?\n>|\r?\nFrom: /)[0].trim().slice(0, 2500) }));
      const last = msgs[msgs.length - 1];
      const jaymeLast = addrs(last.from).some((a) => OWN.test(a));
      if (!followups && jaymeLast) { out.push({ venue: c.venue, skipped: "Jayme wrote last in Gmail" }); return; }
      if (followups && !jaymeLast) { out.push({ venue: c.venue, skipped: "venue wrote last — covered by replies" }); return; }
      if (catchup && jaymeLast) { out.push({ venue: c.venue, skipped: "Jayme wrote last (follow-up case)" }); return; }
      // Check-ins only when Jayme's own last message (per Gmail, not Mailflow's
      // record) is older than --days — a nudge days after his own follow-up
      // reads as a duplicate (ArtYard, Oct 2026).
      if (followups && jaymeLast) {
        const lastMs = Date.parse(last.date);
        if (!Number.isNaN(lastMs) && Date.now() - lastMs < days * 864e5) { out.push({ venue: c.venue, skipped: "Jayme followed up recently" }); return; }
      }
      const transcript = msgs.slice(-6).map((m) => `From: ${m.from}\nDate: ${m.date}\n\n${m.text}`).join("\n\n-----\n\n");
      const res = await anthropic.messages.create({ model: "claude-opus-5-5", max_tokens: 2000, thinking: { type: "adaptive" }, system: SYSTEM, messages: [{ role: "user", content: `Venue: ${c.venue}${c.artist ? ` (artist discussed: ${c.artist})` : ""}\nThread (oldest first):\n\n${transcript}${examplesFor(transcript)}\n\n${followups ? `Jayme wrote the last message ${Math.round((Date.now() - Date.parse(c.last_message_at)) / 864e5)} days ago and hasn't heard back. Draft a short, friendly check-in (1–3 sentences) that picks up exactly where things were left — e.g. "Just checking back to see if you've had a chance to consider…" — without repeating the pitch. If Jayme's last message was a sign-off like "I'll check in when someone on the roster is headed your way" and there's nothing specific to follow up on, answer SKIP.` : "Draft Jayme's reply to the last message."}` }] });
      const textOut = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      const m = textOut.match(/NEEDS_YOU:\s*(.*)\n-{3,}\n([\s\S]*)/);
      if (!m) { out.push({ venue: c.venue, skipped: "model output unparsed" }); return; }
      const needs = m[1].trim(); const body = m[2].trim();
      if (/^SKIP\b/i.test(body)) { out.push({ venue: c.venue, skipped: "no reply needed" }); return; }
      const approve = /^none$/i.test(needs) ? APPROVE_LINE : `${APPROVE_LINE} — NEEDS YOU: ${needs}`;
      if (dry) { out.push({ venue: c.venue, needsYou: needs, skipped: "dry run: " + body.slice(0, 120) }); return; }
      const lastTheirs = [...msgs].reverse().find((x) => !addrs(x.from).some((a) => OWN.test(a)))!;
      const to = addrs(lastTheirs.from)[0];
      const cc = [...new Set(msgs.flatMap((x) => [...addrs(x.from), ...addrs(x.to), ...addrs(x.cc)]))].filter((a) => a !== to && !OWN.test(a) && !/mailer-daemon|noreply|no-reply/.test(a));
      const subject = /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
      const boundary = `dr_${Math.random().toString(36).slice(2)}`;
      const raw = [`From: Jayme Stone <stone@jaymestone.com>`, `To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []), `Subject: ${encodeHeaderWord(subject)}`, `In-Reply-To: ${last.messageId}`, `References: ${[last.references, last.messageId].filter(Boolean).join(" ")}`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
        `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", `${approve}\n\n${toText(body)}\n\n${SIG}\n`,
        `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", `<div dir="ltr"><div><b>${esc(approve)}</b></div><div><br></div>${toHtml(body)}<div><br></div><div>${SIG_HTML}</div></div>`, `--${boundary}--`, ""].join("\r\n");
      const d = await gmail(token, "drafts", { method: "POST", body: JSON.stringify({ message: { threadId, raw: Buffer.from(raw).toString("base64url") } }) });
      out.push({ venue: c.venue, draftId: d.id, threadId, needsYou: /^none$/i.test(needs) ? undefined : needs, body, createdAt: new Date().toISOString() });
      // Keep every original so Jayme's edits can be compared against it later.
      await supabase.from("draft_originals").insert({ draft_id: d.id, thread_id: threadId, venue: c.venue, mode: catchup ? "catchup" : followups ? "followup" : "reply", needs_you: /^none$/i.test(needs) ? null : needs, body }).then(() => {}, () => {});
      console.log(`DRAFT ${c.venue}${/^none$/i.test(needs) ? "" : "  [NEEDS YOU: " + needs + "]"}`);
    } catch (e: any) { out.push({ venue: c.venue, skipped: "error: " + String(e?.message || e).slice(0, 160) }); }
  });
  writeFileSync(catchup ? ".draft-catchup.json" : followups ? ".draft-followups.json" : ".draft-replies.json", JSON.stringify(out, null, 1));
  const made = out.filter((o) => o.draftId);
  console.log(`\n${made.length} drafts, ${made.filter((o) => o.needsYou).length} need a decision, ${out.length - made.length} skipped`);
  for (const o of out.filter((o) => o.skipped)) console.log(`  skipped ${o.venue}: ${o.skipped}`);
})().catch((e) => { console.error(e); process.exit(1); });
