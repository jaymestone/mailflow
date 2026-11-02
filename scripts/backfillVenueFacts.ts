// One-off: fill "Venue facts:" on contacts from their existing booking threads.
//   npx tsx --env-file=.env.local scripts/backfillVenueFacts.ts [--limit N] [--apply]
// Facts-only call (cheaper than a full re-summarize; leaves gists alone).
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { loadThreadMessages } from "../src/lib/conversations/summarizeTick";
import { replaceVenueFacts } from "../src/lib/conversations/venueFacts";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
const apply = process.argv.includes("--apply");
const limit = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : Infinity;
const SYSTEM = "You extract hard, general facts about a music VENUE or PRESENTER from a booking email thread (OUTBOUND = the agent Jayme, INBOUND = the venue). Only facts the venue side stated, true for any artist next year. Terse fragments, under 40 characters each, at most 6, most important first, no sentences. Good: '120 cap', 'Rentals only', 'Summer series only (late May–Aug)', 'Festival mid-July', 'Classical only', 'Local acts only', 'Budget $1.5–4k incl. travel', '60/40 split', 'No accommodations', 'Hosted housing', 'Books Nov–Jan'. Only these kinds: capacity, venue type or limits (rentals only, classical only, local acts only), season or festival timing, typical budget or deal type, housing. Skip anything specific to one offer, date or artist, staff names, location, operational minutiae (door staff, set lengths) and the conversation itself. Return JSON {\"facts\": [...]}, empty if none.";
const SCHEMA = { type: "object", additionalProperties: false, required: ["facts"], properties: { facts: { type: "array", items: { type: "string" } } } } as const;
(async () => {
  const { data: convs } = await s.from("conversations").select("id,venue,contact_id,gmail_thread_ids,thread_key").not("contact_id", "is", null).order("last_message_at", { ascending: false });
  const todo = (convs || []).filter((c) => !/@jaymestone/.test(c.thread_key) && c.gmail_thread_ids?.length).slice(0, limit);
  const byContact = new Map<string, string[]>();
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < todo.length) {
      const c = todo[i++];
      try {
        const msgs = await loadThreadMessages(s, c.gmail_thread_ids);
        if (!msgs.some((m) => m.direction === "inbound")) continue;
        const text = msgs.slice(-20).map((m) => `${m.direction.toUpperCase()} ${m.sentAt}\n${(m.body || "").slice(0, 2000)}`).join("\n\n---\n\n");
        const r = await ai.messages.create({ model: "claude-sonnet-5-5", max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content: `Venue: ${c.venue}\n\n${text}` }], output_config: { format: { type: "json_schema", schema: SCHEMA } } } as any);
        const facts: string[] = JSON.parse((r.content.find((b: any) => b.type === "text") as any)?.text || "{}").facts || [];
        if (facts.length) byContact.set(c.contact_id!, [...(byContact.get(c.contact_id!) || []), ...facts]);
        if (!apply) console.log(c.venue, "→", JSON.stringify(facts));
      } catch (e: any) { console.log("error", c.venue, String(e.message || e).slice(0, 100)); }
    }
  }));
  let n = 0;
  if (apply) for (const [id, facts] of byContact) {
    const { data: ct } = await s.from("contacts").select("notes").eq("id", id).single();
    const merged = replaceVenueFacts(ct?.notes, facts);
    if (merged !== ct?.notes) { await s.from("contacts").update({ notes: merged }).eq("id", id); n++; }
  }
  console.log(`threads ${todo.length}, contacts with facts ${byContact.size}${apply ? `, updated ${n}` : ""}`);
})();
