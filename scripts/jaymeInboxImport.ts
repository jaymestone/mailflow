// One-time: booking threads from the jayme@jaymestone.com inbox (read from
// Apple Mail, which is the only place that mailbox is reachable -- it is not
// a Mailflow connected account) into the booking spreadsheet pipeline.
//
// Each thread is read once with Claude for the same sheet fields the
// summariser writes, then filed as a Mailflow conversation (with a contact,
// so it has a place on the map) for the workbook tick to place: on an
// artist's date row, in "no date yet", or on Leads. Threads for a venue
// Mailflow already tracks are skipped, so nothing doubles up. Master is
// never touched; apparent confirmed bookings missing from it are listed.
//
//   npx tsx --env-file=.env.local scripts/jaymeInboxImport.ts <emails.json> [--apply]

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { normalizeSubject } from "../src/lib/conversations/threadKey";
import { regionFor } from "../src/lib/conversations/region";
import { SHEET_ROSTER } from "../src/lib/workbook/roster";
import { readBookings, sameVenue } from "../src/lib/workbook/plan";
import { batchGet } from "../src/lib/workbook/sheets";
import { MASTER_SPREADSHEET_ID } from "../src/lib/workbook/roster";

const APPLY = process.argv.includes("--apply");
const SRC = process.argv[2];
const CACHE = "scripts/.jayme-inbox-extract.json";
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OWN = /@(jaymestone\.com|jaymestoneagency\.com)/i;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_booking", "venue", "city", "state", "country", "contact_name", "contact_email", "artists", "dates", "window", "interest", "routing_area", "fee", "confirmed", "note", "next_step"],
  properties: {
    is_booking: { type: "boolean", description: "True only if this thread is about a venue, festival or presenter booking one of the roster artists for a performance." },
    venue: { type: "string", description: "The venue, festival or presenting organization." },
    city: { type: ["string", "null"] },
    state: { type: ["string", "null"], description: "US state or Canadian province as a two-letter code, else null." },
    country: { type: ["string", "null"], description: "Country name, e.g. United States, Canada, Denmark." },
    contact_name: { type: ["string", "null"], description: "The venue-side person Jayme is dealing with (not Jayme, not Anya, not an artist)." },
    contact_email: { type: ["string", "null"], description: "That person's email, exactly as written." },
    artists: { type: "array", items: { type: "string", enum: [...SHEET_ROSTER] }, description: "Roster artists this booking is about. Sam Reider & the Human Hands is 'Sam Reider'." },
    dates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "kind", "artist"],
        properties: {
          start: { type: "string", description: "YYYY-MM-DD" },
          end: { type: ["string", "null"] },
          kind: { type: "string", enum: ["confirmed", "hold", "offered", "asked_about"] },
          artist: { anyOf: [{ type: "string", enum: [...SHEET_ROSTER] }, { type: "null" }] },
        },
      },
      description: "Performance dates on the table. Only dates someone wrote; not deadlines or call times.",
    },
    window: { type: ["string", "null"], description: "Timing if no specific date, e.g. 'summer 2027'." },
    interest: { type: "string", enum: ["specific_date", "artist_no_date", "if_routing", "general_roster", "talk_later", "declined"] },
    routing_area: { type: ["string", "null"] },
    fee: { type: ["number", "null"], description: "The current agreed or offered fee in USD, if one is live." },
    confirmed: { type: "boolean", description: "True if the show is agreed: contract sent or signed, or both sides settled on date and fee." },
    note: { type: "string", description: "One line, max 160 characters, for the booking sheet: who, what, fee. Only what the messages say." },
    next_step: { type: "string", description: "Jayme's next action, max 90 characters." },
  },
} as const;
type X = {
  is_booking: boolean; venue: string; city: string | null; state: string | null; country: string | null;
  contact_name: string | null; contact_email: string | null; artists: string[];
  dates: { start: string; end: string | null; kind: string; artist: string | null }[];
  window: string | null; interest: string; routing_area: string | null; fee: number | null; confirmed: boolean; note: string; next_step: string;
};

type Email = { date: string; from: string; subject: string; sender: string; to: string; body: string };

async function extract(text: string): Promise<X> {
  const r = await anthropic.beta.messages.create(
    {
      model: "claude-opus-5-5",
      max_tokens: 4000,
      system: [
        "You read booking email threads for Jayme Stone's music booking agency and fill in his booking sheet.",
        "Jayme Stone and Anya Andrews (admin@jaymestone.com) are the agency. The roster artists are the act being booked.",
        `Today is ${new Date().toISOString().slice(0, 10)}. Dates without a year mean the next occurrence after the message was sent.`,
        "Report only what the messages say.",
      ].join("\n"),
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: text }],
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
    { timeout: 90_000, maxRetries: 2 },
  );
  if (r.stop_reason === "refusal") throw new Error("refused");
  const b = r.content.find((c) => c.type === "text");
  if (!b || b.type !== "text") throw new Error(`no text (${r.stop_reason})`);
  return JSON.parse(b.text) as X;
}

async function main() {
  const emails: Email[] = JSON.parse(readFileSync(SRC, "utf8"));
  // One thread per normalised subject; newest message first (it quotes the rest).
  const threads = new Map<string, Email[]>();
  for (const e of emails) {
    const k = normalizeSubject(e.subject);
    threads.set(k, [...(threads.get(k) ?? []), e]);
  }
  const cache: Record<string, X> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  for (const [k, msgs] of threads) {
    if (cache[k]) continue;
    msgs.sort((a, b) => b.date.localeCompare(a.date));
    const text = msgs
      .map((m, i) => `--- message ${i + 1} (newest first) · ${m.date} · from ${m.sender} · to ${m.to}\nSubject: ${m.subject}\n\n${m.body.slice(0, i === 0 ? 9000 : 2500)}`)
      .join("\n\n");
    try {
      cache[k] = await extract(text);
      writeFileSync(CACHE, JSON.stringify(cache, null, 1));
    } catch (e) {
      console.log(`FAILED ${k}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // What Mailflow already tracks, and what Master already has.
  const { data: convs } = await supabase.from("conversations").select("thread_key, venue, sheet_artists, is_live").limit(3000);
  const masterRows = (await batchGet(MASTER_SPREADSHEET_ID, ["Master!A2:G3000"]))[0];
  const bookings = readBookings(masterRows);

  const out: { k: string; x: X; last: string; action: string }[] = [];
  for (const [k, x] of Object.entries(cache)) {
    const msgs = threads.get(k);
    if (!msgs) continue;
    const last = msgs.map((m) => m.date).sort().pop()!;
    // The workbooks are 2027 calendars; a show this season belongs to Master.
    const future = x.dates.filter((d) => d.start >= "2027-01-01");
    const bookedInMaster = x.artists.length > 0 && x.artists.every((a) => bookings.some((b) => b.artist === a && sameVenue(b.venue, x.venue)));
    let action = "import";
    // Already on the Little Mercies workbook by hand as "Cottonwood Concerts",
    // a name too different to match automatically.
    if (/cottonwood/i.test(x.venue)) action = "skip: already on the workbook (Cottonwood Concerts)";
    else if (!x.is_booking) action = "skip: not a booking";
    else if (x.interest === "declined" || /\bpassed\b|\bdeclined\b|not able to|won't be able/i.test(x.note)) action = "skip: declined";
    else if (x.dates.length && !future.length && !x.window) action = "skip: 2026 show (list for Master)";
    else if (bookedInMaster && !x.window && x.interest !== "talk_later") action = "skip: already booked in Master";
    else if ((convs ?? []).some((c) => c.venue && sameVenue(c.venue, x.venue))) action = "skip: already in Mailflow";
    x.dates = future;
    if (action === "import" && x.confirmed) {
      const inMaster = bookings.some((b) => sameVenue(b.venue, x.venue) && x.artists.includes(b.artist));
      if (!inMaster) action = "import (looks CONFIRMED, not in Master)";
    }
    out.push({ k, x, last, action });
  }
  // Within this import, one venue can arrive as several threads (the
  // Levitt AMP series in Wooster is presented by the Wayne Center; the
  // artists' own availability replies came separately). Same city, same
  // artist: keep the thread with the venue's own contact.
  const hasVenueContact = (x: X) => Boolean(x.contact_email && !OWN.test(x.contact_email));
  const place = (x: X) => `${(x.city ?? "").toLowerCase()}|${(x.state ?? "").toLowerCase()}`;
  for (const o of out.filter((o) => o.action.startsWith("import") && o.x.city)) {
    const rival = out.find(
      (r) => r !== o && r.action.startsWith("import") && place(r.x) === place(o.x) && r.x.artists.some((a) => o.x.artists.includes(a)) && (hasVenueContact(r.x) || !hasVenueContact(o.x)) && (hasVenueContact(r.x) !== hasVenueContact(o.x) || out.indexOf(r) < out.indexOf(o)),
    );
    if (rival) o.action = `skip: same venue as ${rival.x.venue.slice(0, 30)}`;
  }
  for (const o of out.sort((a, b) => a.action.localeCompare(b.action)))
    console.log(`${o.action.padEnd(40)} | ${o.x.venue} (${[o.x.city, o.x.state].filter(Boolean).join(", ")}) | ${o.x.artists.join(", ") || "no artist"} | ${o.x.dates.map((d) => d.start + (d.end ? "–" + d.end.slice(5) : "")).join(", ")} | ${o.x.note.slice(0, 80)}`);

  if (!APPLY) {
    console.log("\nDry run: nothing written.");
    return;
  }

  // List for contacts created here: the CRM's lists are single-membership by
  // import provenance, and these came from the jayme@ inbox.
  let { data: list } = await supabase.from("lists").select("id").eq("name", "jayme@ inbox (Oct 2026)").maybeSingle();
  if (!list) list = (await supabase.from("lists").insert({ name: "jayme@ inbox (Oct 2026)", description: "Booking contacts found in the jayme@jaymestone.com inbox, imported for the booking sheet. In no campaign." }).select("id").single()).data;
  const now = new Date().toISOString();
  let made = 0;
  for (const o of out.filter((o) => o.action.startsWith("import"))) {
    const x = o.x;
    // A thread with only an artist or Anya on it still names a real lead;
    // it just has no venue contact to file it under.
    const email = x.contact_email && !OWN.test(x.contact_email) ? x.contact_email.toLowerCase() : null;
    let contact: { id: string } | null = null;
    if (email) contact = (await supabase.from("contacts").select("id").ilike("email", email).maybeSingle()).data;
    if (email && !contact) {
      const [first, ...rest] = (x.contact_name ?? "").split(/\s+/).filter(Boolean);
      contact = (
        await supabase
          .from("contacts")
          .insert({ email, first_name: first || "Folks", last_name: rest.join(" ") || null, venue: x.venue, city: x.city, state: x.state, country: x.country ?? "United States", list_id: list!.id, source: "jayme@ inbox", notes: "Imported from the jayme@jaymestone.com inbox for the booking sheet, Oct 2026." })
          .select("id")
          .single()
      ).data;
    }
    const { error } = await supabase.from("conversations").insert({
      thread_key: `${email ?? "jayme-inbox"}::${o.k}`,
      venue: x.venue,
      region: regionFor(x.state, x.country),
      contact_id: contact?.id ?? null,
      gmail_thread_ids: [],
      status: x.confirmed ? "confirmed" : "needs_reply",
      fee_amount: x.fee,
      gist: x.note,
      next_action: x.next_step,
      last_message_at: o.last,
      last_direction: "inbound",
      is_live: true,
      // Read once here; the summariser has nothing to re-read (no Mailflow
      // messages), so mark it current.
      summarized_at: now,
      summary_source_hash: "jayme-inbox-import",
      summarized_source_hash: "jayme-inbox-import",
      sheet_artists: x.artists,
      sheet_dates: x.dates,
      sheet_window: x.window,
      sheet_interest: x.interest,
      sheet_routing_area: x.routing_area,
      sheet_note: x.note,
      sheet_next_step: x.next_step,
    });
    if (error) console.log(`insert failed ${x.venue}: ${error.message}`);
    else made++;
  }
  console.log(`\nImported ${made} conversations. The workbook tick places them on its next run.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
