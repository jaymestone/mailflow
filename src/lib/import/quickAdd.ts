import Anthropic from "@anthropic-ai/sdk";

export type QuickAddRow = {
  first_name: string | null;
  last_name: string | null;
  email: string;
  venue: string | null;
  venue_type: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  notes: string | null;
  source: string | null;
  mobile: string | null;
  phone: string | null;
  website: string | null;
};

const ROW_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "venue",
  "venue_type",
  "city",
  "state",
  "country",
  "notes",
  "source",
  "mobile",
  "phone",
  "website",
] as const;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const PARSE_SCHEMA = {
  type: "object" as const,
  properties: {
    contacts: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          first_name: { type: ["string", "null"] as const },
          last_name: { type: ["string", "null"] as const },
          email: { type: "string" as const },
          venue: { type: ["string", "null"] as const },
          venue_type: { type: ["string", "null"] as const },
          city: { type: ["string", "null"] as const },
          state: { type: ["string", "null"] as const },
          country: { type: ["string", "null"] as const },
          notes: { type: ["string", "null"] as const },
          source: { type: ["string", "null"] as const },
          mobile: { type: ["string", "null"] as const },
          phone: { type: ["string", "null"] as const },
          website: { type: ["string", "null"] as const },
        },
        required: [...ROW_FIELDS],
        additionalProperties: false,
      },
    },
  },
  required: ["contacts"],
  additionalProperties: false,
};

const PARSE_SYSTEM = `You extract contact records for a music booking agency's venue contact database from loosely formatted pasted text. Contacts might be one per line, comma-separated, or in loose prose, with wildly inconsistent formatting.

For each distinct contact you can identify: split a full name into first_name/last_name, and capture venue (venue/organization name), venue_type (e.g. "Festival", "Theater", if mentioned), city, state, country, mobile (a personal cell number, if distinguished from a general line), phone (a general/business line), website, source (where this contact came from — e.g. "referred by X", "found on Instagram" — only if the text actually says so), and notes (anything else mentioned that doesn't fit another field).

email is required — if a contact has no email address anywhere in the text, exclude it entirely, since email is how we deduplicate against the existing database.

Leave a field null if it isn't present in the text. Never invent or guess a value that wasn't actually given.`;

export async function parseQuickAddContacts(rawText: string): Promise<QuickAddRow[]> {
  const response = await getClient().messages.create({
    model: "claude-opus-5",
    // The UI invites "one or many contacts" up to 20,000 pasted chars, and
    // each returned contact is an 11-field JSON object (~130-180 tokens
    // even mostly-null) — 8000 tokens caps out around 40-60 contacts. Past
    // that, the response truncates mid-JSON and the whole batch is lost to
    // a raw JSON.parse error instead of returning what did parse.
    max_tokens: 16000,
    system: PARSE_SYSTEM,
    output_config: { format: { type: "json_schema", schema: PARSE_SCHEMA } },
    messages: [{ role: "user", content: rawText.slice(0, 20000) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from parser");
  }
  const parsed = JSON.parse(textBlock.text);
  return parsed.contacts as QuickAddRow[];
}

export type EnrichResult = {
  first_name: string | null;
  last_name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  venue_type: string | null;
  phone: string | null;
  website: string | null;
  confidence: "high" | "medium" | "low";
  note: string;
};

const ENRICH_SYSTEM = `You help fill in missing details for a venue/contact record in a music booking agency's database, using web search when it's useful. You will be given whatever is already known about a venue and contact — which may include their email address, a useful hint for who the contact person is (e.g. "jane.smith@venue.com" suggests Jane Smith) or which venue this is (the domain).

Try to find: the venue's official website, confirm/fill in city, state, country, and venue_type (e.g. "Festival", "Theater", "Bar", "University") if not already given or if uncertain, and the contact person's first and last name if only one or neither was given.

Never guess or fabricate — if you can't confidently determine something (including if there are multiple same-named venues and you can't tell which one this is, or multiple people could plausibly be behind an ambiguous email address), leave that field null rather than pick one and hope. Prefer official/primary sources (the venue's own site, staff/contact pages) over directory listings when confirming details.

Reply with ONLY a single JSON object, no markdown code fences, no other text, in exactly this shape:
{"first_name": string|null, "last_name": string|null, "city": string|null, "state": string|null, "country": string|null, "venue_type": string|null, "phone": string|null, "website": string|null, "confidence": "high"|"medium"|"low", "note": string}

"confidence" reflects how sure you are this is the right venue/contact. "note" is one short sentence on what you found or why you couldn't find it.`;

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in response");
  return text.slice(start, end + 1);
}

const FAILED_ENRICH_RESULT: EnrichResult = {
  first_name: null,
  last_name: null,
  city: null,
  state: null,
  country: null,
  venue_type: null,
  phone: null,
  website: null,
  confidence: "low",
  note: "Couldn't get a usable result — try again or fill in manually.",
};

export async function enrichQuickAddRow(
  row: Pick<QuickAddRow, "first_name" | "last_name" | "email" | "venue" | "city" | "state" | "country">,
): Promise<EnrichResult> {
  const known = Object.entries(row)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: known || "(nothing else is known)" }];

  // Server-tool web search runs and resolves within the same call; pause_turn
  // resume is a defensive edge case (max_uses is small, so this rarely fires).
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await getClient().messages.create({
      model: "claude-opus-5",
      // Shared with adaptive thinking (on by default, uncapped separately)
      // and up to 3 web-search tool-use rounds — a multi-search lookup with
      // real reasoning about source trust can plausibly hit a 4096 ceiling
      // mid-response, truncating before the JSON object closes. Caught by
      // the catch below either way, but a higher ceiling means fewer
      // legitimate lookups fail silently with a "couldn't find it" fallback
      // that was actually a token cap, not a bad search.
      max_tokens: 8000,
      system: ENRICH_SYSTEM,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      messages,
    });

    if (response.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: response.content }];
      continue;
    }

    let lastText = "";
    for (const block of response.content) {
      if (block.type === "text") lastText = block.text;
    }

    try {
      const parsed = JSON.parse(extractJsonObject(lastText));
      return {
        first_name: parsed.first_name ?? null,
        last_name: parsed.last_name ?? null,
        city: parsed.city ?? null,
        state: parsed.state ?? null,
        country: parsed.country ?? null,
        venue_type: parsed.venue_type ?? null,
        phone: parsed.phone ?? null,
        website: parsed.website ?? null,
        confidence: parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low",
        note: typeof parsed.note === "string" ? parsed.note : "",
      };
    } catch {
      return FAILED_ENRICH_RESULT;
    }
  }

  return { ...FAILED_ENRICH_RESULT, note: "Search took too many steps — try again or fill in manually." };
}
