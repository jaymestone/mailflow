// Voice & strategy study: learn how Jayme actually replies to venues, so the
// reply drafter needs fewer edits.
//
//   npx tsx --env-file=.env.local scripts/voiceStudy.ts collect   # → .voice-pairs.json, .voice-corpus.json
//   npx tsx --env-file=.env.local scripts/voiceStudy.ts analyze   # → docs/reply-playbook.md (+ .voice-notes.json)
//
// Pairs: each reply/check-in draft from Oct 17 next to what Jayme approved or
// sent. The original wasn't stored then, so it is regenerated with the same
// base prompt on the same thread (a close stand-in, not byte-exact). Corpus:
// every reply Jayme sent from a connected account since Sept 1, with the venue
// message it answered.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { getAccessToken } from "../src/lib/gmail/client";
import { BASE_SYSTEM } from "../src/lib/drafting/prompt";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OWN = /@jaymestone(agency)?\.com/i;
const LINE = "▶ DELETE THIS LINE TO APPROVE FOR MONDAY";
const MODEL = "claude-opus-5-5";

const plain = (p: any): string => { if (!p) return ""; if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8"); for (const c of p.parts || []) { const t = plain(c); if (t) return t; } return ""; };
const hdr = (m: any, n: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
// Jayme's own words only: drop quoted history and the ◙◙◙ signature block.
const own = (t: string) => t.split(/\r?\nOn [^\n]{5,160}wrote:|\r?\n>|\r?\nFrom: |\r?\n-{2,}\s*Original Message/)[0].split(/\r?\n(?:Kindly|Good things|Best|Thanks so much)?,?\s*\r?\n\s*◙◙◙/)[0].replace(LINE, "").replace(/— NEEDS YOU:[^\n]*/, "").replace(/\n{3,}/g, "\n\n").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

async function gmailGetter(account: string) {
  const { data } = await supabase.from("connected_accounts").select("id").eq("email_address", account).single();
  const token = await getAccessToken(supabase, data!.id);
  return async (path: string) => {
    for (let k = 0; k < 10; k++) { const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } }); if (r.status === 404) return null; if (r.ok) return r.json(); await sleep(3000 * (k + 1)); }
    throw new Error("gmail retries exhausted " + path);
  };
}

async function collect() {
  const get = await gmailGetter("stone@jaymestone.com");
  // ---- pairs
  const sources: { file: string; mode: "reply" | "followup" | "catchup" }[] = [
    { file: ".draft-replies.json", mode: "reply" },
    { file: `${process.env.TMPDIR}/followups-all.json`, mode: "followup" },
    { file: ".draft-catchup.json", mode: "catchup" },
  ];
  const items: { venue: string; draftId: string; mode: string }[] = [];
  for (const s of sources) if (existsSync(s.file)) for (const o of JSON.parse(readFileSync(s.file, "utf8"))) if (o.draftId) items.push({ venue: o.venue, draftId: o.draftId, mode: s.mode });
  const draftsMade = Date.parse("2026-10-17T17:00:00Z");
  const pairs: any[] = [];
  await pool(items, 2, async (it) => {
    try {
      const d = await get(`drafts/${it.draftId}?format=full`);
      let final = "", status = "", threadId = "";
      if (d) {
        threadId = d.message.threadId;
        const body = plain(d.message.payload);
        if (body.includes(LINE)) return; // never approved — nothing learned
        final = own(body); status = "approved draft";
      } else {
        // Sent (or deleted): find Jayme's sent message in that thread after the drafts were made.
        const th = await supabase.from("manual_sends").select("gmail_thread_id,body_text,sent_at").gte("sent_at", "2026-10-17T17:00:00Z").ilike("subject", `%${String(it.venue || "").slice(0, 30)}%`).limit(1);
        const m = th.data?.[0]; if (!m) return;
        threadId = m.gmail_thread_id; final = own(m.body_text || ""); status = "sent";
      }
      const t = await get(`threads/${threadId}?format=full`); if (!t) return;
      const ctx = t.messages.filter((m: any) => !(m.labelIds || []).includes("DRAFT") && Number(m.internalDate) < draftsMade);
      if (!ctx.length || !final) return;
      const transcript = ctx.slice(-6).map((m: any) => `From: ${hdr(m, "From")}\nDate: ${hdr(m, "Date")}\n\n${own(plain(m.payload)).slice(0, 2500)}`).join("\n\n-----\n\n");
      const ask = it.mode === "followup" ? "Jayme wrote the last message and hasn't heard back. Draft a short, friendly check-in (1–3 sentences) that picks up exactly where things were left, without repeating the pitch." : "Draft Jayme's reply to the last message.";
      const res = await anthropic.messages.create({ model: MODEL, max_tokens: 2000, thinking: { type: "adaptive" }, system: BASE_SYSTEM, messages: [{ role: "user", content: `Venue: ${it.venue}\nThread (oldest first):\n\n${transcript}\n\n${ask}` }] });
      const out = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const original = (out.split(/\n-{3,}\n/)[1] || out).trim();
      pairs.push({ venue: it.venue, mode: it.mode, status, context: transcript.slice(-3000), original, final });
      process.stdout.write(".");
    } catch (e: any) { console.log("\npair error", it.venue, String(e?.message || e).slice(0, 120)); }
  });
  writeFileSync(".voice-pairs.json", JSON.stringify(pairs, null, 1));
  console.log(`\n${pairs.length} pairs`);

  // ---- corpus
  const { data: sends } = await supabase.from("manual_sends").select("gmail_thread_id,subject,body_text,sent_at,to_email").gte("sent_at", "2026-09-01").order("sent_at");
  const { data: convs } = await supabase.from("conversations").select("venue,artist,status,gmail_thread_ids");
  const byThread = new Map<string, any>(); for (const c of convs || []) for (const t of c.gmail_thread_ids || []) byThread.set(t, c);
  const corpus: any[] = [];
  for (const m of sends || []) {
    const conv = byThread.get(m.gmail_thread_id); if (!conv) continue; // venue threads only
    const reply = own(m.body_text || ""); if (reply.length < 25 || /New Roster X/.test(reply)) continue;
    const { data: prior } = await supabase.from("inbound_messages").select("body_text,from_email,received_at").eq("gmail_thread_id", m.gmail_thread_id).lt("received_at", m.sent_at).order("received_at", { ascending: false }).limit(1);
    corpus.push({ date: m.sent_at.slice(0, 10), venue: conv.venue, artist: conv.artist, stage: conv.status, venueSaid: prior?.[0] ? own(prior[0].body_text || "").slice(0, 1200) : "(no venue message — Jayme initiating or following up)", jaymeWrote: reply.slice(0, 1500) });
  }
  writeFileSync(".voice-corpus.json", JSON.stringify(corpus, null, 1));
  console.log(`${corpus.length} corpus replies`);
}

async function ask(system: string, user: string, max = 6000) {
  const res = await anthropic.messages.create({ model: MODEL, max_tokens: max, thinking: { type: "adaptive" }, system, messages: [{ role: "user", content: user }] });
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
}

async function analyze() {
  const pairs = JSON.parse(readFileSync(".voice-pairs.json", "utf8"));
  const corpus = JSON.parse(readFileSync(".voice-corpus.json", "utf8"));
  const ANALYST = `You are studying how Jayme Stone, a music booking agent, writes to venue presenters and festival bookers. Be concrete and evidence-based: quote his actual phrasings, give counts or rough frequencies, and note exceptions. Cover BOTH voice (length, openings, sign-offs, punctuation, tone, words he uses and avoids) AND strategy (which artist he leads with and why, how he uses routing and anchor dates, when he names a fee vs asks their budget, how he handles offers/counteroffers/holds, how he moves a conversation to the next step, how he declines or parks, how he follows up and how often, use of links, mentioning Anya or the contract form). Write findings as rules with examples.`;
  const notes: string[] = [];
  const batches: any[][] = []; for (let i = 0; i < corpus.length; i += 60) batches.push(corpus.slice(i, i + 60));
  await pool(batches, 3, async (b) => {
    notes.push(await ask(ANALYST, `Here are ${b.length} of Jayme's replies, each with the venue message it answered:\n\n${b.map((x, i) => `#${i + 1} [${x.date}] ${x.venue}${x.artist ? ` — ${x.artist}` : ""} (stage: ${x.stage})\nVENUE: ${x.venueSaid}\nJAYME: ${x.jaymeWrote}`).join("\n\n====\n\n")}\n\nExtract the patterns.`));
    process.stdout.write("c");
  });
  const pairBatches: any[][] = []; for (let i = 0; i < pairs.length; i += 25) pairBatches.push(pairs.slice(i, i + 25));
  const editNotes: string[] = [];
  await pool(pairBatches, 2, async (b) => {
    editNotes.push(await ask(ANALYST + " Here you are comparing what an AI drafter wrote with what Jayme approved or sent instead. Identify systematically what he changes: what he cuts, adds, rewords, which facts or decisions he inserts, which drafts he left untouched, and the rules that would have produced his version.", `${b.map((p, i) => `#${i + 1} ${p.venue} (${p.mode}, ${p.status})\nCONTEXT (last messages):\n${p.context}\n\nAI DRAFT:\n${p.original}\n\nJAYME'S VERSION:\n${p.final}`).join("\n\n====\n\n")}\n\nWhat does Jayme change, and why?`));
    process.stdout.write("e");
  });
  writeFileSync(".voice-notes.json", JSON.stringify({ notes, editNotes }, null, 1));
  const playbook = await ask(`You write concise, practical style guides. Output Markdown only.`, `Below are analyst notes on (A) ${corpus.length} of Jayme Stone's real replies to venues and (B) ${pairs.length} comparisons of an AI drafter's emails against what Jayme actually approved or sent.

Synthesize them into "Jayme's Reply Playbook": the guide an AI drafter will follow to write replies Jayme can send without editing. Requirements:
- Organized by decision, not by source: Voice; Length & format; Openings & sign-offs; Choosing which artist to lead with; Routing & dates; Fees & money (when to quote, when to ask budget, typical numbers he uses); Offers, holds & closing a deal (form link, Anya); Follow-ups & cadence; Declines, parking & "keep me posted" replies; What NOT to do (the AI's habitual mistakes he corrects); and When to flag NEEDS_YOU vs draft confidently.
- Every rule concrete, with 1–2 real example phrasings from his emails (short quotes).
- Prefer his majority behavior; note real exceptions.
- No invented facts, fees, or artists. About 1,500–2,200 words.

(A) NOTES ON HIS REPLIES:
${notes.join("\n\n---\n\n")}

(B) NOTES ON HIS EDITS TO AI DRAFTS:
${editNotes.join("\n\n---\n\n")}`, 12000);
  writeFileSync("docs/reply-playbook.md", playbook + "\n");
  console.log(`\nwrote docs/reply-playbook.md (${playbook.length} chars)`);
}

const cmd = process.argv[2];
(cmd === "collect" ? collect() : cmd === "analyze" ? analyze() : Promise.reject(new Error("usage: collect | analyze"))).catch((e) => { console.error(e); process.exit(1); });
