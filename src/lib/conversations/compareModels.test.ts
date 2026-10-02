// Runs the REAL summariser over REAL threads on two models and diffs them,
// so the Opus-vs-Sonnet question is answered by evidence rather than by
// guessing which parts of the prompt need reasoning.
//
// This costs money and hits the live API, so it is skipped unless asked
// for. To run it:
//
//   RUN_MODEL_COMPARE=1 npx vitest run src/lib/conversations/compareModels.test.ts
//
// Optional: COMPARE_LIMIT=40 (default 25), COMPARE_MODEL_B=claude-haiku-4-5-20251001
//
// It imports summarizeThread rather than re-implementing the call, because
// a copy would drift from the prompt that actually runs in production and
// then prove nothing about it.
import { describe, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { summarizeThread, type ThreadMessage, type ThreadSummary } from "./summarize";

const RUN = process.env.RUN_MODEL_COMPARE === "1";
const MODEL_A = process.env.COMPARE_MODEL_A ?? "claude-opus-5";
const MODEL_B = process.env.COMPARE_MODEL_B ?? "claude-sonnet-5";
const LIMIT = Number(process.env.COMPARE_LIMIT ?? 25);
const OUT = "/tmp/summarizer-model-compare.txt";

function env(): Record<string, string> {
  return Object.fromEntries(
    readFileSync("/Users/jaymestone/mailflow/.env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

async function loadThread(sb: SupabaseClient, threadIds: string[]): Promise<ThreadMessage[]> {
  const [inbound, manual] = await Promise.all([
    sb.from("inbound_messages").select("subject, body_text, from_email, received_at").in("gmail_thread_id", threadIds),
    sb.from("manual_sends").select("subject, body_text, from_email, sent_at").in("gmail_thread_id", threadIds),
  ]);
  return [
    ...(inbound.data ?? []).map((m: Record<string, string>) => ({
      direction: "inbound" as const,
      from: m.from_email ?? "",
      sentAt: m.received_at,
      subject: m.subject,
      body: m.body_text,
    })),
    ...(manual.data ?? []).map((m: Record<string, string>) => ({
      direction: "outbound" as const,
      from: m.from_email,
      sentAt: m.sent_at,
      subject: m.subject,
      body: m.body_text,
    })),
  ];
}

const money = (v: number | null) => (v === null ? "none" : `$${v.toLocaleString()}`);

describe("summarizer model comparison", () => {
  it.skipIf(!RUN)(
    "diffs two models over real threads",
    async () => {
      const e = env();
      // Cast as the repo's other Supabase-touching tests do: createClient's
      // inferred schema generics do not line up with the bare
      // SupabaseClient the helpers take.
      const sb = createClient(
        e.NEXT_PUBLIC_SUPABASE_URL,
        e.SUPABASE_SERVICE_ROLE_KEY,
      ) as unknown as SupabaseClient;

      // Live threads, busiest first: the ones with a real negotiation in
      // them are where the models can actually disagree. A sample of quiet
      // one-reply threads would agree perfectly and prove nothing.
      const { data: conv, error } = await sb
        .from("conversations")
        .select("id, thread_key, venue, gmail_thread_ids, fee_amount, status")
        .eq("is_live", true)
        .order("last_message_at", { ascending: false })
        .limit(LIMIT);
      if (error) throw new Error(error.message);

      const lines: string[] = [];
      // The two figures the board is actually judged on. Gist wording will
      // always differ between models and that difference is not a defect;
      // a fee or an agreed-flag that moves is.
      let feeDisagreements = 0;
      let agreedDisagreements = 0;
      let compared = 0;
      const failures: string[] = [];

      for (const c of conv ?? []) {
        const messages = await loadThread(sb, (c.gmail_thread_ids as string[]) ?? []);
        if (messages.length === 0) continue;

        let a: ThreadSummary;
        let b: ThreadSummary;
        try {
          // Sequential on purpose: these run against the same rate limit,
          // and a 429 halfway through would look like a disagreement.
          a = await summarizeThread(messages, { model: MODEL_A });
          b = await summarizeThread(messages, { model: MODEL_B });
        } catch (err) {
          failures.push(`${c.thread_key}: ${err instanceof Error ? err.message : "unknown"}`);
          continue;
        }

        compared++;
        const feeDiff = a.fee_amount !== b.fee_amount;
        const agreedDiff = a.is_agreed !== b.is_agreed;
        if (feeDiff) feeDisagreements++;
        if (agreedDiff) agreedDisagreements++;

        const flag = feeDiff || agreedDiff ? "  <<< DISAGREES" : "";
        lines.push(
          `\n=== ${c.venue ?? c.thread_key} (${messages.length} msgs, stored ${money(c.fee_amount as number | null)} / ${c.status})${flag}\n` +
            `  fee        ${MODEL_A}: ${money(a.fee_amount)}${a.fee_note ? ` (${a.fee_note})` : ""}\n` +
            `             ${MODEL_B}: ${money(b.fee_amount)}${b.fee_note ? ` (${b.fee_note})` : ""}\n` +
            `  is_agreed  ${MODEL_A}: ${a.is_agreed}   ${MODEL_B}: ${b.is_agreed}\n` +
            `  is_small   ${MODEL_A}: ${a.is_small}   ${MODEL_B}: ${b.is_small}\n` +
            `  gist A     ${a.gist}\n` +
            `  gist B     ${b.gist}\n` +
            `  next A     ${a.next_action}\n` +
            `  next B     ${b.next_action}`,
        );
      }

      const header =
        `summariser comparison — ${MODEL_A} (A) vs ${MODEL_B} (B)\n` +
        `threads compared: ${compared}\n` +
        `fee_amount disagreements: ${feeDisagreements}/${compared}\n` +
        `is_agreed disagreements:  ${agreedDisagreements}/${compared}\n` +
        (failures.length ? `\nfailed: ${failures.length}\n  ${failures.join("\n  ")}\n` : "") +
        `\nA fee or is_agreed disagreement is the only kind that matters here —\n` +
        `differing gist wording is expected. Read every flagged thread below\n` +
        `before switching models.\n`;

      writeFileSync(OUT, header + lines.join("\n"));
      console.log(`\n${header}\nfull detail: ${OUT}`);
    },
    // Two live model calls per thread, sequential, no retries.
    LIMIT * 90_000,
  );
});
