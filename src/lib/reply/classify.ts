import Anthropic from "@anthropic-ai/sdk";
import type { ReplyCategory } from "./types";

const CATEGORIES: ReplyCategory[] = [
  "interested",
  "not_interested",
  "follow_up",
  "ooo_temporary",
  "ooo_departed",
  "opt_out",
  "bounce",
  "unclear",
];

const SCHEMA = {
  type: "object" as const,
  properties: {
    category: { type: "string" as const, enum: CATEGORIES },
    reasoning: { type: "string" as const, description: "One sentence explaining the classification." },
    ooo_return_date: {
      type: ["string", "null"] as const,
      description:
        "Only when category is ooo_temporary: the ISO date (YYYY-MM-DD) they're expected back, if stated or " +
        "clearly inferable (e.g. \"back March 10th\", \"returning next Monday\"). Null if no date is given, or " +
        "category isn't ooo_temporary.",
    },
  },
  required: ["category", "reasoning", "ooo_return_date"],
  additionalProperties: false,
};

function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You classify inbound email replies to cold outreach sent by a music booking agency to venues and festivals. Classify into exactly one category:

- interested: wants to book the artist, wants more info, asks to schedule a call
- not_interested: explicitly declines or passes
- follow_up: asks to be contacted later, references a future date/season
- ooo_temporary: automated out-of-office / vacation auto-reply for a temporary absence (e.g. "back in office March 10th", "traveling until next week") — the sender still holds this role, just away right now
- ooo_departed: the reply indicates the person no longer works there, the venue/organization is closed, or names a replacement contact — anything suggesting this contact is no longer valid, not just temporarily unavailable
- opt_out: asks to be removed from the list / unsubscribe
- bounce: this is a delivery failure notice that slipped past the rule-based filter (mailer-daemon style content)
- unclear: doesn't clearly fit any other category, needs human review

Today's date is ${today}. If (and only if) the category is ooo_temporary, resolve any stated or clearly implied return date to an absolute ISO date in ooo_return_date; otherwise it must be null.

Judge from the actual reply content only.`;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function classifyReply(
  subject: string,
  body: string,
): Promise<{
  category: ReplyCategory;
  reasoning: string;
  oooReturnDate: string | null;
}> {
  const response = await getClient().messages.create({
    model: "claude-opus-5",
    max_tokens: 1024,
    system: systemPrompt(),
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `Subject: ${subject}\n\nBody:\n${body.slice(0, 4000)}` }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from classifier");
  }
  const parsed = JSON.parse(textBlock.text);
  return { category: parsed.category, reasoning: parsed.reasoning, oooReturnDate: parsed.ooo_return_date ?? null };
}
