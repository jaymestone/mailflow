import Anthropic from "@anthropic-ai/sdk";

/** Reads a whole booking thread and extracts where it actually stands.
 *
 * The thing this must get right is that a negotiation is a SEQUENCE. The
 * first attempt at a booking tracker collapsed each thread to its newest
 * message and lost the deal: Carey Eyer's opening message held the venue,
 * the dates, the two 50-minute sets and the workshop, and his last message
 * was "Let's do it!" -- which, read alone, looked like a contentless reply
 * to a $3,000 figure from earlier in the thread, when it was actually
 * accepting Jayme's $3,500 counter that Mailflow had never captured.
 *
 * Hence two rules encoded in the prompt below: read every message, and
 * when the closing message is an assent with no number in it, report the
 * fee as unknown rather than quoting an older figure. A wrong number here
 * is worse than a blank one -- Jayme would price a deal off it.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export type ThreadMessage = {
  direction: "inbound" | "outbound";
  from: string;
  sentAt: string;
  subject: string | null;
  body: string | null;
};

export type ThreadSummary = {
  gist: string;
  next_action: string;
  fee_amount: number | null;
  fee_note: string | null;
  artist: string | null;
  venue: string | null;
  is_agreed: boolean;
  is_small: boolean;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gist", "next_action", "fee_amount", "fee_note", "artist", "venue", "is_agreed", "is_small"],
  properties: {
    gist: {
      type: "string",
      description:
        "One sentence, max 200 characters, on where this got left. Name the concrete things: dates, number of sets, what was offered, what was asked. Written so Jayme can pick the thread back up without reopening it.",
    },
    next_action: {
      type: "string",
      description:
        "The single next thing to do, max 100 characters, phrased as an instruction (e.g. 'Send contract', 'Reply with August dates'). Empty string if the ball is genuinely not in his court.",
    },
    fee_amount: {
      type: ["number", "null"],
      description:
        "The CURRENT fee figure in USD, if one is live. Null when no number has been named, when the only numbers are a range, or when the last message agrees to something without restating the figure. Never carry forward an older number to fill this in.",
    },
    fee_note: {
      type: ["string", "null"],
      description:
        "Short free text for anything the number alone misses: a range, a door split, 'plus lodging', or which side named it.",
    },
    artist: {
      type: ["string", "null"],
      description: "The artist or band this thread is about, if one is named. Null if it is a general roster conversation.",
    },
    venue: {
      type: ["string", "null"],
      description: "The venue, festival or presenting organization, as they refer to it.",
    },
    is_agreed: {
      type: "boolean",
      description:
        "True when both sides have settled on playing: a fee accepted by both, a date agreed, or a contract sent or signed. Contracting still being outstanding does NOT make it untrue -- that is precisely the state this is meant to catch. An enthusiastic 'we'd love to have you' with no figure and no date is NOT agreed, and neither is a venue saying its own calendar is full.",
    },
    is_small: {
      type: "boolean",
      description:
        "True when this is worth under about $1,000, or is a door split, or is a rental rather than a fee. Jayme does not want these in his eyeline.",
    },
  },
} as const;

function systemPrompt(): string {
  return [
    "You read booking-enquiry email threads for a music booking agency and report where each one stands.",
    "",
    "Jayme Stone runs the agency. Messages marked OUTBOUND are his; INBOUND are the venue's.",
    "",
    "Rules:",
    "1. Read every message in order. The deal terms are often stated once, early, and never repeated.",
    "2. A thread is a negotiation. The last message is rarely the whole story.",
    "3. If the final message agrees to something without naming a figure, set fee_amount to null. Do NOT reach back for an earlier number -- an older figure is very likely the one that was countered, and reporting it as live would misprice the deal.",
    "4. Report only what the messages say. Never infer a fee, a date or a capacity that nobody wrote.",
    "5. The gist is for someone who has read this thread before and needs to recall it in one line. Concrete nouns, not 'they are interested'.",
  ].join("\n");
}

/** Caps per message so one long quoted history can't crowd out the early
 * messages, which are usually where the terms are. */
const PER_MESSAGE_CHARS = 2500;
const MAX_MESSAGES = 30;

function renderThread(messages: ThreadMessage[]): string {
  // Oldest first: the model is being asked to follow a sequence, so it
  // should read it in the order it happened.
  const ordered = [...messages].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  // When a thread is longer than the cap, keep the OLDEST and the NEWEST
  // rather than a plain head or tail -- the terms live at the start and the
  // current state lives at the end; the repetitive middle is what to drop.
  const kept =
    ordered.length <= MAX_MESSAGES
      ? ordered
      : [...ordered.slice(0, MAX_MESSAGES / 2), ...ordered.slice(-MAX_MESSAGES / 2)];

  return kept
    .map((m, i) => {
      const tag = m.direction === "outbound" ? "OUTBOUND (Jayme)" : "INBOUND (venue)";
      const body = (m.body ?? "").slice(0, PER_MESSAGE_CHARS);
      return `--- message ${i + 1} · ${tag} · ${m.sentAt} · from ${m.from}\nSubject: ${m.subject ?? ""}\n\n${body}`;
    })
    .join("\n\n");
}

export async function summarizeThread(messages: ThreadMessage[]): Promise<ThreadSummary> {
  if (messages.length === 0) throw new Error("summarizeThread: no messages");

  // Short timeout and no retries for the same reason the reply classifier
  // has them: cron-job.org kills the whole function at 30 seconds, so a
  // single hung call must not take the rest of the batch down with it.
  // This thread is simply re-summarised on the next tick.
  const response = await getClient().messages.create(
    {
      model: "claude-opus-5",
      max_tokens: 2048,
      system: systemPrompt(),
      // Medium, not low. This looked like bounded extraction against a
      // fixed schema, but it is not: reading a negotiation means tracking
      // which of several figures is still live and whether an exchange
      // amounted to agreement. At low effort the same thread gave
      // different answers between runs -- re-summarising the priced
      // threads moved the count with a fee from 24 to 18, and Blue Waters
      // produced a gist saying "booked, agreement sent Sept 30" while
      // still reporting the booking as not agreed. Both are the same
      // failure: the reasoning needed to reconcile a sequence was being
      // skipped. The cost is bounded by the per-tick batch, not by this.
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: renderThread(messages) }],
    },
    { timeout: 20000, maxRetries: 0 },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No text response from summarizer");
  return JSON.parse(textBlock.text) as ThreadSummary;
}
