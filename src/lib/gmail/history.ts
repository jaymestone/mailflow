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
): Promise<{ messageIds: string[]; newHistoryId: string }> {
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
      // history); re-baseline from the current historyId rather than failing forever.
      if (res.status === 404) {
        return { messageIds: [], newHistoryId: await getCurrentHistoryId(accessToken) };
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

  return { messageIds: [...messageIds], newHistoryId };
}
