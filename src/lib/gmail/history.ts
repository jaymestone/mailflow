export async function getCurrentHistoryId(accessToken: string): Promise<string> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail getProfile failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.historyId;
}

export async function listNewMessageIds(
  accessToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; newHistoryId: string; wasReset: boolean }> {
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let newHistoryId = startHistoryId;

  do {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
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
        return { messageIds: [], newHistoryId: await getCurrentHistoryId(accessToken), wasReset: true };
      }
      throw new Error(`Gmail history.list failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();

    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        messageIds.add(added.message.id);
      }
    }
    if (data.historyId) newHistoryId = data.historyId;
    pageToken = data.nextPageToken;
  } while (pageToken);

  return { messageIds: [...messageIds], newHistoryId, wasReset: false };
}

/** Direct message search, independent of the history-based incremental sync
 * above -- used as a recovery path when a history reset (see wasReset above)
 * may have created a gap the incremental API can no longer see into. Gmail
 * search query syntax (e.g. "newer_than:2d"), not a historyId. */
export async function searchMessageIds(accessToken: string, query: string): Promise<string[]> {
  const messageIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: query, maxResults: "50" });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Gmail messages.list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();

    for (const m of data.messages ?? []) messageIds.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return messageIds;
}
