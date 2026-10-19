// The reply drafter's instructions (scripts/draftReplies.ts). Kept here so
// the voice study (scripts/voiceStudy.ts) regenerates drafts with exactly the
// same prompt. PLAYBOOK, when present, is appended: it's the distilled guide
// to Jayme's voice and booking strategy (docs/reply-playbook.md).
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { stopsNear, type Puzzle, type Stop } from "@/lib/routing/clusters";

export const BASE_SYSTEM = `You draft email replies for Jayme Stone, a booking agent (Jayme Stone Agency), replying to venue presenters and festival bookers who wrote back to him. Jayme will review every draft before it is sent.

His voice: short sentences, warm, plain, no cleverness, no announced structure, no "problem-then-solution" phrasing, no tidy triplets. Typical lines: "Good to hear from you, [Name]." "Thanks so much!" "Happy to chat anytime." "Curious if there might be an opportunity…" "Could you hold [date] for us?" "What's your budget range?" Keep replies brief — usually 2–5 sentences. Do NOT write a sign-off or signature (it's added automatically). Start with "Hi [first name]," or "Good to hear from you, [first name]." Write plain text; you may link an artist name as [ARTIST NAME IN CAPS](https://www.jaymestone.com/agency/<slug>).

Hard rules:
- Never invent facts. Only state what's in the thread or in the context below.
- Never name a new fee, confirm a date, accept or decline an offer, or agree to terms. If the venue asked for a fee, prefer asking their budget range. If a decision is needed (an offer, a hold, a date, a fee, a rate), still write the best draft you can with a placeholder in square brackets for Jayme to fill (e.g. "[$X]" or "[which date?]"), and say what's needed in NEEDS_YOU.
- If they asked a question you can't answer from the context (tech rider, tour history, specific availability), draft a holding line or ask a clarifying question, and flag it in NEEDS_YOU.
- If the thread doesn't need a reply at all (e.g. a polite "thanks, will keep you in mind" after Jayme's own sign-off), say SKIP.

Context Jayme is working with (true facts you may use):
- He lives in Longmont, Colorado. He is in the studio producing a record Oct 17–20, 2026 (don't mention this).
- Roster & slugs: The Little Mercies (the-little-mercies) — old-time trio, twin fiddles, three-part harmony; Charlie & The Tropicales (charlie-and-the-tropicales) — six-piece New Orleans band, calypso/cumbia/rocksteady; Amanda Pascali (amanda-pascali) — Gen Z troubadour revitalizing Sicilian songs, based in Austin; Rakish (rakish) — Celtic tradition and Appalachian roots; Samir Langus (samir-langus) — Moroccan trance music from New York; Summer Camargo (summer-camargo) — SNL's youngest horn player, leading her own band; Sam Reider & The Human Hands (sam-reider); Lily Henley (lily-henley) — Sephardic ballads meet American roots; Jorge Glem & Sam Reider (jorge-glem-and-sam-reider). Full roster: https://www.jaymestone.com/agency
- Current routing: Charlie & The Tropicales close the Green Box Arts Festival, Green Mountain Falls CO, Sat July 17, 2027 — booking a Colorado run around it. The Little Mercies play Blue Waters Bluegrass Festival, Medical Lake WA, Aug 7–8, 2027 — building a West Coast tour (WA → OR → CA) through August 2027. Amanda Pascali plays the Manship Theatre, Baton Rouge, Fri Jan 22, 2027, driving from Austin — booking Gulf South dates around it. The Little Mercies showcase at ArtsMarket (Durham NC) Mon Nov 2, 2026, 6:55–7:10pm; their manager Alexei Mejouev has a booth; Jayme won't attend.
- When a deal is agreed, Jayme sends the venue a form link and his assistant Anya sends the agreement — but agreeing is Jayme's call (NEEDS_YOU).

Output exactly this format:
NEEDS_YOU: <one short line, or "none">
---
<the email body, or the single word SKIP>`;

// Real examples of Jayme's replies (docs/reply-examples.json: [{venueSaid,
// jaymeWrote}]), chosen per draft by word overlap with the venue's message,
// so the drafter sees how he actually answered similar situations.
type Example = { venueSaid: string; jaymeWrote: string };
let examplesCache: Example[] | null = null;
function examples(): Example[] {
  if (examplesCache) return examplesCache;
  const p = join(process.cwd(), "docs", "reply-examples.json");
  examplesCache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
  return examplesCache!;
}
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) || []);
export function examplesFor(context: string, n = 12): string {
  const ex = examples(); if (!ex.length) return "";
  const w = words(context);
  const scored = ex.map((e) => { const ew = words(e.venueSaid + " " + e.jaymeWrote); let k = 0; for (const x of ew) if (w.has(x)) k++; return { e, k: k / Math.sqrt(ew.size + 1) }; }).sort((a, b) => b.k - a.k).slice(0, n);
  return `\n\nHere is how Jayme actually replied in similar situations. Match his length, wording and moves closely:\n\n${scored.map((s, i) => `Example ${i + 1}\nVENUE: ${s.e.venueSaid.slice(0, 500)}\nJAYME: ${s.e.jaymeWrote}`).join("\n\n")}`;
}

export function systemPrompt(): string {
  const p = join(process.cwd(), "docs", "reply-playbook.md");
  return existsSync(p) ? `${BASE_SYSTEM}\n\n=== JAYME'S REPLY PLAYBOOK (follow this closely; it overrides general guidance above where they differ) ===\n\n${readFileSync(p, "utf8")}` : BASE_SYSTEM;
}

// Past shows by roster artists (docs/venue-history.json, built from each
// artist's folder, the agency site's Performance Highlights, Bandsintown and
// web research). Venues ask "have they played here before?" a lot, so the
// drafter gets every past show in the venue's state/province.
type Show = { artist: string; date: string; venue: string; city: string; state: string; country: string; event: string; kind?: string };
let historyCache: Show[] | null = null;
function history(): Show[] {
  if (historyCache) return historyCache;
  const p = join(process.cwd(), "docs", "venue-history.json");
  historyCache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
  return historyCache!;
}
export function historyFor(loc: { city?: string | null; state?: string | null; country?: string | null } | null | undefined, perArtist = 15): string {
  const st = (loc?.state || "").trim().toLowerCase();
  if (!st) return "";
  const cn = (c?: string | null) => { const x = (c || "").trim().toLowerCase(); return /^(us|usa|u\.s\.a?\.?|united states)/.test(x) ? "us" : /^(ca|canada)$/.test(x) ? "ca" : x; };
  const hits = history().filter((s) => s.state.toLowerCase() === st && (!loc?.country || !s.country || cn(s.country) === cn(loc.country)));
  if (!hits.length) return `\n\nRoster history: no past shows on record in ${loc!.state} for any artist (records may be incomplete — don't claim they've never played there; flag NEEDS_YOU if it matters).`;
  const by = new Map<string, Show[]>();
  for (const s of hits) by.set(s.artist, [...(by.get(s.artist) || []), s]);
  const lines = [...by].map(([a, ss]) => `- ${a}: ${ss.slice(0, perArtist).map((s) => `${s.venue}${s.event && s.event !== s.venue ? ` (${s.event})` : ""}, ${s.city}${s.date ? ` ${s.date.slice(0, 4)}` : ""}${s.kind === "opener" ? " (as opener)" : ""}`).join("; ")}${ss.length > perArtist ? `; +${ss.length - perArtist} more` : ""}`);
  return `\n\nRoster history — past shows in ${loc!.state} (venue is in ${loc!.city || "?"}, ${loc!.state}). Use these if the venue asks whether an artist has played the area, or when a local credential would help; don't list them unprompted:\n${lines.join("\n")}`;
}

// Routing context from the workbook tick's snapshot (app_settings
// "routing_snapshot"): upcoming calendar dates near this venue, and the
// cluster it belongs to, so a reply can say "Lily's in Tampa March 5 —
// could you do the 6th or 7th?" instead of a generic "let me know".
export function routingFor(snapshot: { stops: Stop[]; puzzles: Puzzle[] } | null, conversationId: string, at: { lat?: number | null; lng?: number | null } | null | undefined, today = new Date().toISOString().slice(0, 10)): string {
  if (!snapshot) return "";
  const parts: string[] = [];
  if (at?.lat != null && at?.lng != null) {
    const near = stopsNear(snapshot.stops, { lat: at.lat, lng: at.lng }, today).slice(0, 8);
    if (near.length) parts.push(`Upcoming roster dates within 200 miles (from Jayme's tour calendar; Confirmed/Booked are real, Hold/Inquiry are not public — never mention those venues by name):\n${near.map((s) => `- ${s.artist}: ${s.start}${s.end !== s.start ? `–${s.end}` : ""} ${/^confirmed|booked/i.test(s.status) ? s.venue : "(tentative)"}, ${s.city} ${s.state} — ${s.status}, ${s.miles} mi`).join("\n")}`);
  }
  const p = snapshot.puzzles.find((x) => x.venues.some((v) => v.id === conversationId));
  if (p) parts.push(`This venue is one of ${p.venues.length} in the ${p.area} that are interested if someone's in the area${p.byArtist.length ? ` (most asked about: ${p.byArtist.slice(0, 3).map((a) => `${a.artist} ×${a.count}`).join(", ")})` : ""}. Jayme's next move for that cluster: ${p.move}`);
  if (!parts.length) return "";
  return `\n\nRouting context — use it when the venue says "let me know when someone's in the area", asks about dates, or a nearby date would make a natural offer. Propose real dates only next to a Confirmed/Booked date. If there's nothing to offer yet, don't mention routing:\n${parts.join("\n\n")}`;
}
