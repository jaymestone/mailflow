"use client";

import { useState } from "react";

type ReprocessResult = {
  windowDays: number;
  dryRun: boolean;
  bounceCandidateCount: number;
  replyCandidateCount: number;
  truncated: boolean;
  bounceResult: { bounces: number; suppressed: number };
  replyResult: { replies: number; pausedElsewhere: number; removedForReplacement: number };
  errors: { account: string; gmailMessageId: string; error: string }[];
};

/** Same failure mode as the 2026-09-16 incident: an inbox message that
 * never made it into Mailflow at all, so nothing else on this page (or
 * anywhere in the app) even knows to show it as a problem. This runs the
 * exact real pipeline directly against Gmail for whatever it finds --
 * "Preview" is read-only (just a Gmail search + a local classifyBounce
 * check, no writes), "Run" is the real thing: real classification,
 * matching, and for some messages, real suppression or pausing a live
 * campaign contact. */
export function ReprocessControls() {
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [result, setResult] = useState<ReprocessResult | null>(null);

  async function run(dryRun: boolean) {
    if (!dryRun && !confirm("Reprocess stuck messages? This classifies and matches real messages, and can suppress or pause real contacts.")) {
      return;
    }
    setBusy(dryRun ? "preview" : "run");
    setResult(null);
    const res = await fetch("/api/admin/reprocess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun }),
    });
    const data = await res.json();
    setBusy(null);
    setResult(data);
  }

  return (
    <div className="mt-3 rounded-[3px] border border-hairline bg-surface p-[18px_20px]">
      <p className="text-sm text-muted">
        Searches every connected inbox for messages with no Mailflow category label at all -- not just missing a
        label, but never recorded in the first place. Preview is read-only; Run applies the real pipeline
        (classification, matching, and any resulting suppression or pause) to whatever it finds.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => run(true)}
          disabled={busy !== null}
          className="rounded-[2px] border border-hairline px-4 py-2 text-xs font-semibold text-muted-2 disabled:opacity-50"
        >
          {busy === "preview" ? "Checking…" : "Preview"}
        </button>
        <button
          type="button"
          onClick={() => run(false)}
          disabled={busy !== null}
          className="rounded-[2px] border border-hairline px-4 py-2 text-xs font-semibold text-muted-2 disabled:opacity-50"
        >
          {busy === "run" ? "Running…" : "Run"}
        </button>
      </div>

      {result && (
        <div className="mt-4 text-sm">
          <p className="text-ink">
            {result.dryRun ? "Would process" : "Processed"} {result.bounceCandidateCount} bounce(s) and{" "}
            {result.replyCandidateCount} genuine reply/auto-reply message(s), from the last {result.windowDays} day
            {result.windowDays === 1 ? "" : "s"}.
          </p>
          {!result.dryRun && (
            <ul className="mt-1.5 space-y-0.5 text-ink-soft">
              <li>Bounces recorded: {result.bounceResult.bounces} (suppressed: {result.bounceResult.suppressed})</li>
              <li>
                Replies recorded: {result.replyResult.replies} (paused elsewhere: {result.replyResult.pausedElsewhere}
                , queued for replacement: {result.replyResult.removedForReplacement})
              </li>
            </ul>
          )}
          {result.truncated && (
            <p className="mt-1.5 text-error">
              More candidates were found than this run processed -- re-run to continue.
            </p>
          )}
          {result.errors.length > 0 && (
            <div className="mt-2">
              <p className="text-error">{result.errors.length} error(s):</p>
              <ul className="mt-1 space-y-0.5 text-muted-3">
                {result.errors.map((e, i) => (
                  <li key={i}>
                    {e.account} {e.gmailMessageId}: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
