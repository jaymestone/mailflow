// One-time pass over the live booking conversations, pulling out what the
// 2027 artist workbooks need: which artist, which dates, what kind of
// interest, and where routing would have to pass.
//
// Read-only against Supabase. Results are cached per conversation in
// scripts/.workbook-extract.json so a hung call or a rerun never re-bills
// a thread that already came back; delete the file to start over.
//
//   npx tsx --env-file=.env.local scripts/workbookExtract.ts [--limit N]

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "fs";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CACHE = "scripts/.workbook-extract.json";
const LIMIT = Number(process.argv[process.argv.indexOf("--limit") + 1]) || Infinity;
const CONCURRENCY = 4;

// Kavita Shah is deliberately absent: Jayme no longer represents her.
export const ROSTER = [
  "The Little Mercies", "Rakish", "Amanda Pascali", "Sam Reider", "Jorge Glem & Sam Reider",
  "Lily Henley", "Samir Langus", "Charlie & The Tropicales", "Summer Camargo",
] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["artists", "dates", "target_window", "interest", "routing_area", "note", "next_step"],
  properties: {
    artists: {
      type: "array",
      items: { type: "string", enum: [...ROSTER] },
      description:
        "Roster artists the VENUE has shown interest in, or that a specific offer or date is about. If Jayme's pitch was about one artist only (e.g. subject 'The Little Mercies X ...') and the venue replied with interest, include that artist. For a whole-roster pitch, only artists the venue singled out, or that Jayme offered for a specific date the venue engaged with -- not every artist listed. Sam Reider & the Human Hands is 'Sam Reider'. Empty if the venue is interested in the roster generally.",
    },
    dates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "kind", "artist"],
        properties: {
          artist: {
            anyOf: [{ type: "string", enum: [...ROSTER] }, { type: "null" }],
            description: "Which roster artist this date is for, when the thread ties it to one. Null if the date is for the venue generally.",
          },
          start: { type: "string", description: "YYYY-MM-DD" },
          end: { type: ["string", "null"], description: "YYYY-MM-DD for a multi-day run, else null" },
          kind: { type: "string", enum: ["confirmed", "hold", "offered", "asked_about"] },
        },
      },
      description:
        "Specific calendar dates on the table for a performance (festival dates, a requested night, an offered date). Only dates someone actually wrote. Not follow-up dates or deadlines.",
    },
    target_window: {
      type: ["string", "null"],
      description:
        "When it could happen if there is no specific date, in a few words: 'spring 2027', 'late 2027', '2027-28 season', 'Oct-Nov 2027'. Null if nothing was said.",
    },
    interest: {
      type: "string",
      enum: ["specific_date", "artist_no_date", "if_routing", "general_roster", "talk_later", "declined"],
      description:
        "specific_date: a date or dates are on the table. artist_no_date: interested in a named artist, no date yet. if_routing: interested only if an artist is touring nearby. general_roster: likes the roster, nothing specific. talk_later: asked to reconnect at a later time (e.g. 'talk in January'). declined: not interested / passed.",
    },
    routing_area: {
      type: ["string", "null"],
      description: "For if_routing: the place routing has to pass, as they put it ('Chicago', 'BC / Golden', 'Tucson'). Else null.",
    },
    note: {
      type: "string",
      description:
        "One line, max 160 characters, for Jayme's booking sheet: who, what was said, any fee or capacity. Concrete. No filler. Only what the messages say.",
    },
    next_step: { type: "string", description: "Jayme's next action, max 90 characters." },
  },
} as const;

export type Extract = {
  artists: string[];
  dates: { start: string; end: string | null; kind: string; artist?: string | null }[];
  target_window: string | null;
  interest: string;
  routing_area: string | null;
  note: string;
  next_step: string;
};

const SYSTEM = [
  "You read booking-enquiry email threads for Jayme Stone's music booking agency and fill in his booking sheet.",
  "Messages marked OUTBOUND are Jayme's; INBOUND are the venue's.",
  "Report only what the messages say. Never infer a date, fee or artist nobody wrote.",
  `Today is ${new Date().toISOString().slice(0, 10)}. Dates without a year mean the next occurrence after the message was sent.`,
].join("\n");

const OWN = /@(jaymestone\.com|jaymestoneagency\.com)$/i;

async function threadText(threadIds: string[]): Promise<string> {
  const [inb, man] = await Promise.all([
    supabase.from("inbound_messages").select("subject, body_text, from_email, received_at").in("gmail_thread_id", threadIds),
    supabase.from("manual_sends").select("subject, body_text, from_email, sent_at").in("gmail_thread_id", threadIds),
  ]);
  const msgs = [
    ...(inb.data ?? []).map((m) => ({ at: m.received_at, from: m.from_email ?? "", subject: m.subject, body: m.body_text })),
    ...(man.data ?? []).map((m) => ({ at: m.sent_at, from: m.from_email, subject: m.subject, body: m.body_text })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const kept = msgs.length <= 30 ? msgs : [...msgs.slice(0, 15), ...msgs.slice(-15)];
  return kept
    .map((m, i) => {
      const tag = OWN.test(m.from) ? "OUTBOUND (Jayme)" : "INBOUND (venue)";
      return `--- message ${i + 1} · ${tag} · ${m.at} · from ${m.from}\nSubject: ${m.subject ?? ""}\n\n${(m.body ?? "").slice(0, 2500)}`;
    })
    .join("\n\n");
}

async function extract(text: string): Promise<Extract> {
  const response = await anthropic.beta.messages.create(
    {
      model: "claude-opus-5-5",
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: text }],
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
    { timeout: 90_000, maxRetries: 2 },
  );
  if (response.stop_reason === "refusal") throw new Error("refused");
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error(`no text (stop ${response.stop_reason})`);
  return JSON.parse(block.text) as Extract;
}

async function main() {
  const cache: Record<string, Extract> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const { data, error } = await supabase
    .from("conversations")
    .select("id, thread_key, venue, gmail_thread_ids")
    .eq("is_live", true)
    .limit(2000);
  if (error) throw error;
  // --multi re-extracts only threads naming several artists with dates, so
  // each date can be tied to the artist it was offered for.
  const multi = process.argv.includes("--multi");
  const todo = (data ?? [])
    .filter((c) => (c.gmail_thread_ids ?? []).length)
    .filter((c) => (multi ? cache[c.id] && cache[c.id].artists.length > 1 && cache[c.id].dates.length > 0 : !cache[c.id]))
    .slice(0, LIMIT);
  console.log(`${data?.length} live conversations, ${Object.keys(cache).length} cached, ${todo.length} to extract`);

  let done = 0;
  let failed = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          cache[c.id] = await extract(await threadText(c.gmail_thread_ids));
          done++;
          if (done % 20 === 0) {
            writeFileSync(CACHE, JSON.stringify(cache, null, 1));
            console.log(`  ${done}/${todo.length}`);
          }
        } catch (e) {
          failed++;
          console.log(`  FAILED ${c.venue ?? c.thread_key}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }),
  );
  writeFileSync(CACHE, JSON.stringify(cache, null, 1));
  console.log(`done: ${done} extracted, ${failed} failed, ${Object.keys(cache).length} cached in total`);
}

if (process.argv[1]?.endsWith("workbookExtract.ts")) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
