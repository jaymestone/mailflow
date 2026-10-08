/** A small Google Sheets client for the booking spreadsheet.
 *
 * Authenticates as jayme@jaymestone.com -- the account that owns
 * [MASTER] Tour Dates -- with the same OAuth client and refresh token
 * Contract Engine uses to append to it. Separate from the Gmail OAuth in
 * src/lib/oauth/google.ts: different Google project, different scopes,
 * and one account rather than five.
 *
 * Plain fetch against the REST API rather than googleapis: the calls are
 * few and the bundle stays small. Every call has a short timeout because
 * this runs inside cron-job.org's 30-second ceiling.
 */

let cached: { token: string; expiresAt: number } | null = null;

export function sheetsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SHEETS_CLIENT_ID && process.env.GOOGLE_SHEETS_CLIENT_SECRET && process.env.GOOGLE_SHEETS_REFRESH_TOKEN);
}

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_SHEETS_CLIENT_ID!,
      client_secret: process.env.GOOGLE_SHEETS_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_SHEETS_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Sheets token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | string[]> } = {}): Promise<T> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, x);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Sheets ${init.method ?? "GET"} ${path.split("/").slice(1).join("/")}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export type Cell = string | number | boolean;

export async function getSheetTitles(id: string): Promise<{ title: string; sheetId: number }[]> {
  const r = await call<{ sheets: { properties: { title: string; sheetId: number } }[] }>(id, { query: { fields: "sheets.properties(title,sheetId)" } });
  return r.sheets.map((s) => s.properties);
}

export async function batchGet(id: string, ranges: string[], render: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" = "FORMATTED_VALUE"): Promise<Cell[][][]> {
  if (!ranges.length) return [];
  const r = await call<{ valueRanges: { values?: Cell[][] }[] }>(`${id}/values:batchGet`, { query: { ranges, valueRenderOption: render } });
  return r.valueRanges.map((v) => v.values ?? []);
}

export async function batchUpdateValues(id: string, data: { range: string; values: Cell[][] }[], input: "RAW" | "USER_ENTERED"): Promise<void> {
  for (let i = 0; i < data.length; i += 300)
    await call(`${id}/values:batchUpdate`, { method: "POST", body: { valueInputOption: input, data: data.slice(i, i + 300) } });
}

export async function batchClear(id: string, ranges: string[]): Promise<void> {
  if (ranges.length) await call(`${id}/values:batchClear`, { method: "POST", body: { ranges } });
}

export async function batchUpdate(id: string, requests: unknown[]): Promise<void> {
  if (requests.length) await call(`${id}:batchUpdate`, { method: "POST", body: { requests } });
}
