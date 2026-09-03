import Anthropic from "@anthropic-ai/sdk";

export type ReplacementQuery = {
  venue: string | null;
  venue_type: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  removed_contact_email: string;
  removed_reason: string;
};

export type ReplacementResult =
  | {
      found: true;
      first_name: string | null;
      last_name: string | null;
      email: string;
      venue: string | null;
      venue_type: string | null;
      city: string | null;
      state: string | null;
      country: string | null;
      website: string | null;
      confidence: "high" | "medium" | "low";
      usedGenericFallback: boolean;
      note: string;
    }
  | { found: false; note: string };

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM = `You research replacement booking contacts for a music booking agency's outreach list. A previous contact at a venue went dead — their email permanently bounced, or their out-of-office said they no longer work there — and you're finding who books/handles talent at this venue now, so outreach to this venue can continue with someone reachable.

Standard: a real named person's personal email is the goal. A real name paired with the venue's own shared/generic inbox (e.g. info@, booking@) is acceptable ONLY as a last resort, after genuinely trying to find a named contact via staff pages, press coverage, parent-org directories, etc — never reached for first. A bare generic address with no name attached at all is not acceptable — report found: false instead of using one.

Never guess or fabricate a name or email. If you can't confirm the venue still exists, can't find any current booking contact, or aren't confident which of several same-named venues this is, report found: false with a short note explaining why.

Reply with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"found": true, "first_name": string|null, "last_name": string|null, "email": string, "venue": string|null, "venue_type": string|null, "city": string|null, "state": string|null, "country": string|null, "website": string|null, "confidence": "high"|"medium"|"low", "usedGenericFallback": boolean, "note": string}
or
{"found": false, "note": string}

"usedGenericFallback" is true only when the email is a shared/generic inbox rather than a personal one — report it honestly, never hide it. "note" is one short sentence on what you found, or why you couldn't.`;

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in response");
  return text.slice(start, end + 1);
}

const FAILED_RESULT: ReplacementResult = {
  found: false,
  note: "Couldn't get a usable result from research — try again or fill in manually.",
};

export async function findReplacementContact(query: ReplacementQuery): Promise<ReplacementResult> {
  const known = Object.entries(query)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: known }];

  // Same pause_turn resume pattern as enrichQuickAddRow — finding a brand
  // new contact (not just filling in known-venue details) is a harder
  // search, so this gets one more web_search round than that does.
  //
  // This whole function runs inside a 60s Vercel function (the daily
  // replacement-research cron route), with only one item processed per
  // run — a per-call timeout keeps a slow or hung request from silently
  // eating that entire budget with nothing to show for it (confirmed in
  // production: an unbounded call here is exactly what blew past even
  // Vercel's 60s ceiling, not just cron-job.org's shorter one). maxRetries
  // is kept low since this loop can already run up to 3 times on its own
  // for legitimate pause_turn continuations — stacking the SDK's own
  // retries on top risks far more total calls than the time budget allows.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await getClient().messages.create(
      {
        model: "claude-opus-5",
        max_tokens: 8000,
        system: SYSTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
        messages,
      },
      { timeout: 18000, maxRetries: 1 },
    );

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
      if (parsed.found !== true) {
        return { found: false, note: typeof parsed.note === "string" ? parsed.note : "No replacement found." };
      }
      if (typeof parsed.email !== "string" || !parsed.email.includes("@")) {
        return { found: false, note: "Research returned no usable email." };
      }
      return {
        found: true,
        first_name: parsed.first_name ?? null,
        last_name: parsed.last_name ?? null,
        email: parsed.email,
        venue: parsed.venue ?? null,
        venue_type: parsed.venue_type ?? null,
        city: parsed.city ?? null,
        state: parsed.state ?? null,
        country: parsed.country ?? null,
        website: parsed.website ?? null,
        confidence: parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low",
        usedGenericFallback: parsed.usedGenericFallback === true,
        note: typeof parsed.note === "string" ? parsed.note : "",
      };
    } catch {
      return FAILED_RESULT;
    }
  }

  return { found: false, note: "Search took too many steps — try again or fill in manually." };
}
