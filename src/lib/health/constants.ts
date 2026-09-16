/** Shared by the Health page and the alert checker so the two can never
 * disagree about what "stale" means for a given job -- keeping this in one
 * place instead of copied into both. */
// replacement-research-tick is deliberately not included -- its actual
// expected cadence isn't documented anywhere in the code, and guessing one
// risks false "stale" alerts, which would undermine trust in this list
// faster than leaving a known gap.
export const EXPECTED_INTERVAL_MINUTES: Record<string, number> = {
  "geocode-tick": 1,
  "send-engine-tick": 15,
  "reply-poll-tick": 5,
};
