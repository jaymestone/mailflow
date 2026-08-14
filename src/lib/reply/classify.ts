import Anthropic from "@anthropic-ai/sdk";
import type { ReplyCategory } from "./types";

const CATEGORIES: ReplyCategory[] = [
  "interested",
  "not_interested",
  "follow_up",
  "ooo",
  "opt_out",
  "bounce",
  "unclear",
];

const SCHEMA = {
  type: "object" as const,
  properties: {
    category: { type: "string" as const, enum: CATEGORIES },
    reasoning: { type: "string" as const, description: "One sentence explaining the classification." },
  },
  required: ["category", "reasoning"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You classify inbound email replies to cold outreach sent by a music booking agency to venues and festivals. Classify into exactly one category:

- interested: wants to book the artist, wants more info, asks to schedule a call
- not_interested: explicitly declines or passes
- follow_up: asks to be contacted later, references a future date/season
- ooo: automated out-of-office / vacation auto-reply
- opt_out: asks to be removed from the list / unsubscribe
- bounce: this is a delivery failure notice that slipped past the rule-based filter (mailer-daemon style content)
- unclear: doesn't clearly fit any other category, needs human review

Judge from the actual reply content only.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function classifyReply(subject: string, body: string): Promise<{
  category: ReplyCategory;
  reasoning: string;
}> {
  const response = await getClient().messages.create({
    model: "claude-opus-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `Subject: ${subject}\n\nBody:\n${body.slice(0, 4000)}` }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from classifier");
  }
  const parsed = JSON.parse(textBlock.text);
  return { category: parsed.category, reasoning: parsed.reasoning };
}
