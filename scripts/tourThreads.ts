// Tour push helper: find the stone@ Gmail thread behind a conversation and
// read it, or put a reply DRAFT into that thread for Jayme to review.
// Nothing here sends mail.
//
//   npx tsx --env-file=.env.local scripts/tourThreads.ts read <conversationId> [...]
//   npx tsx --env-file=.env.local scripts/tourThreads.ts draft <drafts.json>
//
// drafts.json: [{ "conversationId": "...", "body": "plain text, no signature" }]
//   or, for a thread Mailflow has no conversation row for (or that lives in
//   another connected mailbox): { "account": "agency@jaymestone.com",
//   "threadQuery": "from:someone@venue.org", "venue": "...", "body": "..." }
// Optional "to" addresses the draft to someone other than the last sender;
// optional "subject" replaces the "Re: <last subject>" line;
// optional "cc" replaces the Cc list worked out from the thread.
//
//   npx tsx --env-file=.env.local scripts/tourThreads.ts new <drafts.json>
// A brand-new (unthreaded) draft from stone@:
//   [{ "to": "Name <a@b.org>", "cc": ["c@b.org"], "subject": "...", "body": "..." }]
// The signature is appended in Jayme's own format. Each draft is threaded
// (threadId + In-Reply-To/References) and addressed to whoever wrote last
// from the venue side, with anyone else on the thread from the venue in Cc.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getAccessToken, encodeHeaderWord } from "../src/lib/gmail/client";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const REPLY_FROM = "stone@jaymestone.com";
const OWN = /@jaymestone(agency)?\.com$/i;
const SIGNATURE = "Kindly,\n\n◙◙◙   Jayme Stone\n◙◙◙   303.495.0989\n◙◙◙   jaymestone.com\n◙◙◙   instigator / integrator";
const SIGNATURE_HTML = 'Kindly,<br><br>◙◙◙&nbsp;&nbsp; Jayme Stone<br>◙◙◙&nbsp;&nbsp; 303.495.0989<br>◙◙◙&nbsp;&nbsp; <a href="https://www.jaymestone.com">jaymestone.com</a><br>◙◙◙&nbsp;&nbsp; instigator / integrator';

// Bodies may use [TEXT](url) for links, the way Jayme links artist names,
// and *Title* for italics (album titles).
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toText = (b: string) => b.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 <$2>").replace(/\*([^*\n]+)\*/g, "$1");
const toHtml = (b: string) =>
  b.split(/\n{2,}/).map((para) => `<div>${esc(para).replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>').replace(/\*([^*\n]+)\*/g, "<i>$1</i>").replace(/\n/g, "<br>")}</div>`).join("<div><br></div>");

type Gm = { id: string; threadId: string; payload: any; internalDate: string };

async function gmail(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`Gmail ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

const header = (m: Gm, name: string) =>
  (m.payload.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

function plainText(part: any): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts || []) { const t = plainText(p); if (t) return t; }
  return "";
}

const addrs = (v: string) => (v.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map((a) => a.toLowerCase());

async function account(email = REPLY_FROM) {
  const { data } = await supabase.from("connected_accounts").select("id,email_address").eq("email_address", email).single();
  return { id: data!.id as string, email, token: await getAccessToken(supabase, data!.id) };
}
const stoneAccount = () => account();

// The conversation's thread ids span every connected mailbox; Gmail thread ids
// are per mailbox, so find the one stone@ holds. Falls back to searching
// stone@ for the counterpart's address.
async function stoneThread(conversationId: string, acct: { id: string; token: string }) {
  const { data: c } = await supabase.from("conversations").select("id,venue,thread_key,gmail_thread_ids").eq("id", conversationId).single();
  if (!c) throw new Error(`no conversation ${conversationId}`);
  const ids: string[] = c.gmail_thread_ids || [];
  const { data: inb } = await supabase.from("inbound_messages").select("gmail_thread_id,received_at").eq("connected_account_id", acct.id).in("gmail_thread_id", ids).order("received_at", { ascending: false }).limit(1);
  const { data: man } = await supabase.from("manual_sends").select("gmail_thread_id,sent_at").eq("connected_account_id", acct.id).in("gmail_thread_id", ids).order("sent_at", { ascending: false }).limit(1);
  let threadId = inb?.[0]?.gmail_thread_id || man?.[0]?.gmail_thread_id || null;
  if (!threadId) {
    const who = String(c.thread_key).split("::")[0];
    const r = await gmail(acct.token, `threads?maxResults=5&q=${encodeURIComponent(`from:${who} OR to:${who}`)}`);
    threadId = r.threads?.[0]?.id || null;
  }
  return { conversation: c, threadId };
}

async function readThread(threadId: string, token: string) {
  const t = await gmail(token, `threads/${threadId}?format=full`);
  return (t.messages as Gm[]).map((m) => ({
    m, from: header(m, "From"), to: header(m, "To"), cc: header(m, "Cc"), date: header(m, "Date"),
    subject: header(m, "Subject"), messageId: header(m, "Message-ID"), references: header(m, "References"),
    text: plainText(m.payload).split(/\r?\nOn [^\n]{5,120}wrote:|\r?\n>/)[0].trim(),
  }));
}

async function cmdRead(ids: string[]) {
  const acct = await stoneAccount();
  for (const id of ids) {
    const { conversation, threadId } = await stoneThread(id, acct);
    console.log(`\n######## ${conversation.venue} (${id}) thread=${threadId}`);
    if (!threadId) continue;
    const msgs = await readThread(threadId, acct.token);
    for (const x of msgs.slice(-5)) console.log(`--- ${x.date} | ${x.from}\n${x.text.slice(0, 1200)}`);
  }
}

async function cmdDraft(file: string) {
  const stone = await stoneAccount();
  const items: { conversationId?: string; account?: string; threadQuery?: string; venue?: string; to?: string; cc?: string[]; subject?: string; body: string }[] = JSON.parse(readFileSync(file, "utf8"));
  for (const it of items) {
    const acct = it.account ? await account(it.account) : stone;
    let conversation: any = { venue: it.venue }, threadId: string | null = null;
    if (it.threadQuery) {
      const r = await gmail(acct.token, `threads?maxResults=1&q=${encodeURIComponent(it.threadQuery)}`);
      threadId = r.threads?.[0]?.id || null;
    } else ({ conversation, threadId } = await stoneThread(it.conversationId!, acct));
    if (!threadId) { console.log(`SKIP ${conversation.venue}: no stone@ thread`); continue; }
    // Only real mail: a draft (or a deleted draft still listed in the thread)
    // has a Message-ID the venue never received, and replying to it breaks
    // threading on their side (Newport, Nov 6).
    const msgs = (await readThread(threadId, acct.token)).filter((x) => !(x.m as Gm & { labelIds?: string[] }).labelIds?.some((l) => l === "DRAFT" || l === "TRASH"));
    if (!msgs.length) { console.log(`SKIP ${conversation.venue}: no sent or received mail in this thread`); continue; }
    const last = msgs[msgs.length - 1];
    const lastTheirs = [...msgs].reverse().find((x) => !addrs(x.from).some((a) => OWN.test(a)));
    // A thread of only Jayme's own messages (e.g. unanswered campaign mail) needs an explicit "to".
    if (!lastTheirs && !it.to) { console.log(`SKIP ${conversation.venue}: no message from the venue in this thread`); continue; }
    // "to" overrides the recipient, e.g. the colleague someone introduced; the
    // introducer then lands in Cc with everyone else from the venue side.
    const to = (it.to || addrs(lastTheirs!.from)[0]).toLowerCase();
    const cc = it.cc ?? [...new Set(msgs.flatMap((x) => [...addrs(x.from), ...addrs(x.to), ...addrs(x.cc)]))]
      .filter((a) => a !== (addrs(to)[0] || to) && !OWN.test(a) && !/mailer-daemon|noreply|no-reply/.test(a));
    // "subject" renames the thread (it still threads via In-Reply-To/References).
    const subject = it.subject ?? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`);
    const refs = [last.references, last.messageId].filter(Boolean).join(" ").trim();
    const boundary = `tour_${Date.now().toString(36)}`;
    const raw = [
      `From: Jayme Stone <${acct.email}>`,
      `To: ${to}`,
      ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
      `Subject: ${encodeHeaderWord(subject)}`,
      `In-Reply-To: ${last.messageId}`,
      `References: ${refs}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `${toText(it.body.trim())}\n\n${SIGNATURE}\n`,
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `<div dir="ltr">${toHtml(it.body.trim())}<div><br></div><div>${SIGNATURE_HTML}</div></div>`,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const d = await gmail(acct.token, "drafts", { method: "POST", body: JSON.stringify({ message: { threadId, raw: Buffer.from(raw).toString("base64url") } }) });
    console.log(`DRAFT [${acct.email}] ${conversation.venue}: to ${to}${cc.length ? ` cc ${cc.join(", ")}` : ""} (draft ${d.id})`);
  }
}

function mime(from: string, headers: string[], body: string) {
  const boundary = `tour_${Date.now().toString(36)}`;
  return [
    `From: Jayme Stone <${from}>`, ...headers, "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "",
    `${toText(body.trim())}\n\n${SIGNATURE}\n`,
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "",
    `<div dir="ltr">${toHtml(body.trim())}<div><br></div><div>${SIGNATURE_HTML}</div></div>`,
    `--${boundary}--`, "",
  ].join("\r\n");
}

async function cmdNew(file: string) {
  const acct = await stoneAccount();
  const items: { to: string; cc?: string[]; subject: string; body: string }[] = JSON.parse(readFileSync(file, "utf8"));
  for (const it of items) {
    const raw = mime(acct.email, [`To: ${it.to}`, ...(it.cc?.length ? [`Cc: ${it.cc.join(", ")}`] : []), `Subject: ${encodeHeaderWord(it.subject)}`], it.body);
    const d = await gmail(acct.token, "drafts", { method: "POST", body: JSON.stringify({ message: { raw: Buffer.from(raw).toString("base64url") } }) });
    console.log(`NEW DRAFT [${acct.email}] "${it.subject}" to ${it.to}${it.cc?.length ? ` cc ${it.cc.join(", ")}` : ""} (draft ${d.id})`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === "read" ? cmdRead(rest) : cmd === "draft" ? cmdDraft(rest[0]) : cmd === "new" ? cmdNew(rest[0]) : Promise.reject(new Error("usage: read <ids...> | draft <file> | new <file>")))
  .catch((e) => { console.error(e); process.exit(1); });
