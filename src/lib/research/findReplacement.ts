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

// One budget for the whole function, including every pause_turn
// continuation -- see the long note in findReplacementContact for why a
// per-call timeout alone was letting this blow past the route's real
// ~30s ceiling. Sized to leave headroom for the surrounding DB work.
const TOTAL_RESEARCH_BUDGET_MS = 24_000;
// Below this there isn't enough left for a web search to plausibly
// finish, so stopping cleanly beats burning the remainder.
const MIN_ATTEMPT_MS = 6_000;

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
  // This runs inside the replacement-research cron route, whose real
  // ceiling is cron-job.org's ~30s client timeout, not Vercel's 60s
  // maxDuration -- disconnecting past that point kills the in-flight
  // function outright.
  //
  // The previous shape could not fit inside that ceiling, and the
  // production record shows it: of 378 queued venues, 1 succeeded and
  // 134 were given up on, every failure reading "Request timed out."
  // Two compounding causes, both fixed here:
  //
  //  1. Per-call budget without a TOTAL budget. Each attempt got its own
  //     20s timeout and the loop runs up to 3 times for legitimate
  //     pause_turn continuations -- up to 60s, double the ceiling. So
  //     even a search that was working got killed mid-flight. There is
  //     now a single deadline for the whole function, and each call is
  //     given only what remains of it.
  //
  //  2. The work didn't fit the budget. Opus with up to 4 web-search
  //     rounds and an 8k token allowance is a lot of machinery for what
  //     is really "find this venue's contact page and read an address
  //     off it". Sonnet handles that comfortably and is markedly faster,
  //     which is the whole game when the wall is ~30s. Fewer search
  //     rounds cuts the slowest part directly, and a smaller token
  //     allowance discourages long reasoning detours before the JSON.
  //
  // maxRetries stays 0 (not the SDK default): an SDK retry silently
  // doubles a call's wall time (confirmed: maxRetries 1 turned one 18s
  // timeout into ~36s), which the deadline below would then have to
  // absorb. Fail fast and let the next run retry instead -- with the
  // queue now running every 15 minutes rather than daily, a retry is
  // minutes away, not a day.
  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESEARCH_BUDGET_MS - (Date.now() - startedAt);

  for (let attempt = 0; attempt < 3; attempt++) {
    // Leave enough room to be worth attempting at all; below this a call
    // would almost certainly be cut off mid-search and waste the budget.
    if (remainingMs() < MIN_ATTEMPT_MS) break;

    const response = await getClient().messages.create(
      {
        model: "claude-sonnet-5",
        max_tokens: 2000,
        system: SYSTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
        messages,
      },
      { timeout: remainingMs(), maxRetries: 0 },
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

  // Two different ways to land here, and the distinction matters to
  // whoever reads this note later: running out of search rounds means the
  // venue was genuinely hard to pin down, whereas running out of time
  // means we never got a real answer either way and a retry is worthwhile.
  return remainingMs() < MIN_ATTEMPT_MS
    ? { found: false, note: "Ran out of time before the search finished — worth retrying." }
    : { found: false, note: "Search took too many steps — try again or fill in manually." };
}
