export async function getCurrentHistoryId(accessToken: string): Promise<string> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail getProfile failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.historyId;
}

// Hard cap on how many history.list pages a single call will page through.
// This was unbounded until 2026-09-15. It turned out NOT to be the actual
// cause of that day's string of reply-poll-tick timeouts (that was a
// self-inflicted Gmail API per-minute rate limit from repeated manual
// testing while debugging -- see git history for the full chase, several
// other hypotheses were tried and reverted first). Kept anyway as real
// defense-in-depth: today's much higher send volume means more history
// accumulates between polls than before, and nothing should ever page
// through it unboundedly regardless of what triggers a large gap.
const MAX_HISTORY_PAGES = 3;

export async function listNewMessageIds(
  accessToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; newHistoryId: string; wasReset: boolean; truncated: boolean }> {
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let newHistoryId = startHistoryId;
  let pagesFetched = 0;

  do {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
      maxResults: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      // A 404 here means the startHistoryId is too old (Gmail only retains ~1 week of
      // history) or otherwise unrecognized -- re-baseline from the current historyId
      // rather than failing forever. wasReset:true tells the caller a real gap may
      // exist between the old checkpoint and now, so it can fall back to a direct
      // search instead of silently treating this the same as "nothing new."
      if (res.status === 404) {
        return { messageIds: [], newHistoryId: await getCurrentHistoryId(accessToken), wasReset: true, truncated: false };
      }
      throw new Error(`Gmail history.list failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    pagesFetched++;

    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        messageIds.add(added.message.id);
      }
    }
    if (data.historyId) newHistoryId = data.historyId;
    pageToken = data.nextPageToken;

    if (pageToken && pagesFetched >= MAX_HISTORY_PAGES) {
      // More pages exist but stopping here to stay inside the time budget.
      // truncated:true tells the caller NOT to advance the stored checkpoint
      // to newHistoryId -- Gmail's per-page historyId reflects the mailbox's
      // current state, not "as of this page," so trusting it here would
      // silently skip whatever was on the unfetched remaining pages (the
      // same class of bug the 404/reset handling above exists to avoid).
      // Leaving the checkpoint where it was means the next tick re-fetches
      // these same first MAX_HISTORY_PAGES pages -- cheap (existing-row
      // skips) except for the couple of genuinely new messages each tick's
      // own processing cap allows through, so this account drains
      // gradually over successive ticks instead of ever timing out.
      return { messageIds: [...messageIds], newHistoryId: startHistoryId, wasReset: false, truncated: true };
    }
  } while (pageToken);

  return { messageIds: [...messageIds], newHistoryId, wasReset: false, truncated: false };
}

/** Direct message search, independent of the history-based incremental sync
 * above -- used as a recovery path when a history reset (see wasReset above)
 * may have created a gap the incremental API can no longer see into. Gmail
 * search query syntax (e.g. "newer_than:2d"), not a historyId.
 *
 * Deliberately a single page (up to 50), not the full paginated result set
 * -- confirmed live: paginating through every match before returning
 * anything (a busy account's 2-day window can span hundreds of messages)
 * made the calling cron request exceed cron-job.org's 30s hard timeout
 * before a single message had even started processing. The caller only
 * ever fully processes a handful anyway (MAX_NEW_MESSAGES_PER_TICK), so one
 * page is already generous headroom, not a meaningful limitation. */
export async function searchMessageIds(accessToken: string, query: string): Promise<string[]> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: query, maxResults: "50" })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Gmail messages.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.messages ?? []).map((m: { id: string }) => m.id);
}
