import { createClient } from "@supabase/supabase-js";
import { getAccessToken } from "../src/lib/gmail/client";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const { data } = await s.from("connected_accounts").select("id").eq("email_address", "stone@jaymestone.com").single();
  const tok = await getAccessToken(s, data!.id);
  const g = async (p: string) => { for (let k = 0; k < 6; k++) { const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { headers: { Authorization: `Bearer ${tok}` } }); if (r.ok) return r.json(); await new Promise((x) => setTimeout(x, 2000 * (k + 1))); } throw new Error(p); };
  const drafts: any[] = []; let pt = "";
  do { const d = await g(`drafts?maxResults=500${pt ? `&pageToken=${pt}` : ""}`); drafts.push(...(d.drafts || [])); pt = d.nextPageToken || ""; } while (pt);
  const byThread = new Map<string, string[]>();
  for (const d of drafts) byThread.set(d.message.threadId, [...(byThread.get(d.message.threadId) || []), d.id]);
  console.log("drafts", drafts.length, "threads", byThread.size);
  for (const [t, ids] of byThread) if (ids.length > 1) console.log("TWO DRAFTS IN ONE THREAD", t, ids.join(","));
  // A draft written before Jayme's own latest sent message in that thread = probably stale/duplicate.
  let n = 0;
  for (const [t, ids] of byThread) {
    const th = await g(`threads/${t}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To`);
    const sent = th.messages.filter((m: any) => m.labelIds?.includes("SENT") && !m.labelIds?.includes("DRAFT"));
    const lastSent = Math.max(0, ...sent.map((m: any) => Number(m.internalDate)));
    for (const m of th.messages.filter((m: any) => m.labelIds?.includes("DRAFT"))) {
      const h = (x: string) => (m.payload.headers || []).find((y: any) => y.name === x)?.value || "";
      if (lastSent > Number(m.internalDate)) { n++; console.log(`STALE: you sent ${new Date(lastSent).toISOString().slice(0, 16)} after draft ${new Date(Number(m.internalDate)).toISOString().slice(0, 16)} | ${h("To").slice(0, 40)} | ${h("Subject").slice(0, 60)} | ${m.snippet.slice(0, 70)}`); }
    }
  }
  console.log("stale", n);
})();
