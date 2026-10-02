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
  // Runs every minute; 2 here means the alert fires after six minutes of
  // silence (the checker uses 3x), which tolerates a missed tick without
  // tolerating an outage. Added 2026-10-02 after this job's cron-job.org
  // schedule went missing and the board sat frozen for sixteen hours with
  // twenty booking replies invisible on it -- nothing watched this job, so
  // nothing said a word.
  "conversations-tick": 2,
  // Runs every 15 minutes, so this alerts after 45 of silence. Added
  // alongside conversations-tick: both jobs' schedules disappeared the
  // same night and neither was watched by anything.
  "notion-sync-tick": 15,
};
