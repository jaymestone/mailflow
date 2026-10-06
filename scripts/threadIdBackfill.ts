// One-time: gives every Booking Pipeline row its Thread ID, and reports the
// duplicate rows the old keying left behind.
//
// Dry run by default -- reads Supabase and Notion, writes nothing. With
// --apply it writes Thread ID onto the rows listed under "would update",
// and nothing else: duplicates are reported for Jayme to remove by hand,
// never deleted or merged here.
//
// The Thread IDs come from running the real build pass in dry-run mode,
// so what this reports is exactly what the deployed code will produce.
//
//   npx tsx --env-file=.env.local scripts/threadIdBackfill.ts [--apply]

import { createClient } from "@supabase/supabase-js";
import { runConversationBuildTick } from "../src/lib/conversations/buildTick";

const DATABASE_ID = "558b5fcae3cb4c3aacce10845f5d0b23";
const APPLY = process.argv.includes("--apply");
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const token = process.env.NOTION_TOKEN!;
const OWN = /@(jaymestone\.com|jaymestoneagency\.com)::/;

async function notion(path: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const body = await res.json();
    if (!res.ok) throw new Error(`Notion ${res.status}: ${body.message}`);
    return body;
  }
}

type Page = { id: string; venue: string; key: string };

async function notionPages(): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  do {
    const body = await notion(`/databases/${DATABASE_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    for (const p of body.results) {
      const props = p.properties;
      out.push({
        id: p.id.replace(/-/g, ""),
        venue: (props.Venue?.title ?? []).map((t: { plain_text: string }) => t.plain_text).join(""),
        key: (props["Mailflow key"]?.rich_text ?? []).map((t: { plain_text: string }) => t.plain_text).join(""),
      });
    }
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);
  return out;
}

type Conv = { id: string; thread_key: string; venue: string | null; notion_page_id: string | null; gmail_thread_ids: string[] | null };

async function main() {
  const build = await runConversationBuildTick(supabase, { dryRun: true });
  const next = (build.preview ?? []) as { thread_key: string; thread_id: string; venue: string | null; gmail_thread_ids: string[] }[];
  const nextByKey = new Map(next.map((r) => [r.thread_key, r]));
  const nextByGmail = new Map<string, (typeof next)[number]>();
  for (const r of next) for (const g of r.gmail_thread_ids) if (!nextByGmail.has(g)) nextByGmail.set(g, r);

  const { data } = await supabase.from("conversations").select("id, thread_key, venue, notion_page_id, gmail_thread_ids").limit(2000);
  const convs = (data ?? []) as Conv[];
  const convByPage = new Map(convs.filter((c) => c.notion_page_id).map((c) => [c.notion_page_id!.replace(/-/g, ""), c]));

  const pages = await notionPages();

  const update: { page: Page; threadId: string }[] = [];
  const unmatched: { page: Page; why: string }[] = [];
  // thread id -> every page that belongs to it
  const groups = new Map<string, { page: Page; kept: boolean; key: string }[]>();
  const add = (threadId: string, page: Page, kept: boolean, key: string) =>
    groups.set(threadId, [...(groups.get(threadId) ?? []), { page, kept, key }]);

  for (const page of pages) {
    const conv = convByPage.get(page.id);
    if (!conv) {
      unmatched.push({ page, why: "no Mailflow conversation points at this row" });
      continue;
    }
    const same = nextByKey.get(conv.thread_key);
    if (same) {
      update.push({ page, threadId: same.thread_id });
      add(same.thread_id, page, true, conv.thread_key);
      continue;
    }
    // The new build no longer produces this row's key: its messages now
    // belong to another row. Find that row through a shared Gmail thread.
    const absorbedBy = (conv.gmail_thread_ids ?? []).map((g) => nextByGmail.get(g)).find(Boolean);
    if (absorbedBy) add(absorbedBy.thread_id, page, false, conv.thread_key);
    else unmatched.push({ page, why: `key ${conv.thread_key} is no longer produced and shares no thread with a kept row` });
  }

  const dupes = [...groups.entries()].filter(([, g]) => g.length > 1 || g.some((x) => !x.kept));

  const line = (p: Page) => `${p.venue || "(no venue)"}  [${p.key}]  https://www.notion.so/${p.id}`;
  console.log(`\nBooking Pipeline: ${pages.length} rows in Notion, ${convs.length} conversations in Mailflow, ${next.length} after the fix`);
  console.log(`Build: ${build.ownRepliesAttached} of Jayme's own messages attached to a venue's row, ${build.noExternalSkipped} skipped (no outside participant)\n`);

  console.log(`== WOULD UPDATE: ${update.length} rows get a Thread ID`);
  for (const u of update.slice(0, 15)) console.log(`  ${line(u.page)}\n      Thread ID ${u.threadId}`);
  if (update.length > 15) console.log(`  ... and ${update.length - 15} more`);

  console.log(`\n== DUPLICATES: ${dupes.length} conversations have more than one row. Keep the first, remove the rest by hand.`);
  for (const [threadId, g] of dupes) {
    g.sort((a, b) => Number(b.kept) - Number(a.kept) || Number(OWN.test(a.key)) - Number(OWN.test(b.key)));
    console.log(`  Thread ${threadId}`);
    for (const x of g) console.log(`    ${x.kept ? "KEEP  " : "remove"}  ${line(x.page)}`);
  }

  const storedKeys = new Set(convs.map((c) => c.thread_key));
  const fresh = next.filter((r) => !storedKeys.has(r.thread_key));
  console.log(`\n== NEW ROWS: ${fresh.length} conversations would get a brand-new Notion row on the next sync`);
  for (const r of fresh) console.log(`  ${r.venue || "(no venue)"}  [${r.thread_key}]`);

  console.log(`\n== CAN'T MATCH: ${unmatched.length}`);
  for (const u of unmatched) console.log(`  ${line(u.page)}\n      ${u.why}`);

  if (!APPLY) {
    console.log("\nDry run: nothing was written. Re-run with --apply to write Thread IDs.");
    return;
  }
  let done = 0;
  for (const u of update) {
    await notion(`/pages/${u.page.id}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { "Thread ID": { rich_text: [{ text: { content: u.threadId } }] } } }),
    });
    done++;
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`\nWrote Thread ID to ${done} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
