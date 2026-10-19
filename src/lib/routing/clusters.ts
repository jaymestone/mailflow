// Routing puzzles: where interest is piling up geographically, and what the
// next move is. Jayme (2026-10-18): "If you're seeing six venues in Florida
// all say 'let me know when you have someone in the area', we can start to
// put together almost like a Sudoku puzzle. You have one piece of
// information that helps you focus on how to get the next part moving."
//
// Pure: the workbook tick feeds it the leads and calendar stops it already
// loads, and stores the result in app_settings for the morning briefing and
// the reply drafter.

export type Coord = { lat: number; lng: number };
export type PuzzleLead = {
  id: string;
  venue: string;
  city: string;
  state: string;
  coord: Coord;
  interest: string; // if_routing | artist_no_date | specific_date | general_roster | talk_later
  artists: string[];
  window: string | null;
  fee: number | null;
  pitchedRecently?: boolean; // Jayme wrote last, within the past 3 weeks
};
export type Stop = { artist: string; start: string; end: string; venue: string; city: string; state: string; status: string; coord: Coord };
export type Puzzle = {
  area: string; // "FL" or "Tampa, FL area"
  states: string[];
  venues: { id: string; venue: string; city: string; state: string; interest: string; artists: string[]; window: string | null; fee: number | null }[];
  byArtist: { artist: string; count: number }[];
  windows: string[];
  anchors: (Omit<Stop, "coord"> & { miles: number })[];
  move: string;
};

export const ROUTING_SNAPSHOT_KEY = "routing_snapshot";
export const ROUTING_CLOSED_KEY = "routing_closed"; // [{ artist, venue, note }] — dates Jayme isn't routing around
export type Closed = { artist: string; venue: string; note?: string };
export const isClosed = (s: { artist: string; venue: string }, closed: Closed[]) =>
  closed.some((c) => c.artist.toLowerCase() === s.artist.toLowerCase() && s.venue.toLowerCase().includes(c.venue.toLowerCase()));
export const CLUSTER_MILES = 150;
export const ANCHOR_MILES = 200;
const PIECES = new Set(["if_routing", "artist_no_date", "specific_date"]);

export const miles = (a: Coord, b: Coord) => {
  const R = 3958.8, r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const fmtDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const fmtSpan = (a: string, b: string) => { if (a === b) return fmtDay(a); const [x, y] = [fmtDay(a), fmtDay(b)]; return x.slice(0, 3) === y.slice(0, 3) ? `${x.replace(/, \d{4}$/, "")}–${y.replace(/^\w+ /, "")}` : `${x.replace(/, \d{4}$/, "")}–${y}`; };

const top = <T,>(xs: T[], n: number) => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
};

/** Greedy: seed on the lead with the most pieces within CLUSTER_MILES, take them, repeat. */
export function findPuzzles(leads: PuzzleLead[], stops: Stop[], today: string, minVenues = 3): Puzzle[] {
  const seen = new Set<string>();
  let pool = leads.filter((l) => PIECES.has(l.interest) && !seen.has(l.venue.toLowerCase()) && seen.add(l.venue.toLowerCase()));
  const out: Puzzle[] = [];
  while (pool.length >= minVenues) {
    const seed = pool
      .map((l) => ({ l, n: pool.filter((o) => miles(l.coord, o.coord) <= CLUSTER_MILES).length }))
      .sort((a, b) => b.n - a.n)[0];
    if (seed.n < minVenues) break;
    const group = pool.filter((o) => miles(seed.l.coord, o.coord) <= CLUSTER_MILES);
    pool = pool.filter((o) => !group.includes(o));
    out.push(describe(group, stops, today));
  }
  return out.sort((a, b) => b.venues.length - a.venues.length);
}

function describe(group: PuzzleLead[], stops: Stop[], today: string): Puzzle {
  const states = top(group.map((g) => g.state).filter(Boolean), 3).map(([s]) => s);
  const cities = top(group.map((g) => g.city).filter(Boolean), 1);
  // Name it by its centre: the city nearest the middle of the group.
  const mid = { lat: group.reduce((t, g) => t + g.coord.lat, 0) / group.length, lng: group.reduce((t, g) => t + g.coord.lng, 0) / group.length };
  const centre = [...group].sort((a, b) => miles(a.coord, mid) - miles(b.coord, mid))[0];
  const area = `${states.join(" / ") || "Unplaced"}${centre?.city ? ` — around ${centre.city}` : ""}`;
  void cities;
  const byArtist = top(group.flatMap((g) => g.artists), 9).map(([artist, count]) => ({ artist, count }));
  const windows = top(group.map((g) => g.window).filter(Boolean) as string[], 3).map(([w]) => w);
  // Best anchor = the upcoming date the most venues here could route around
  // (venues that named its artist or no artist), then confirmed, then soonest.
  const fitsOf = (artist: string, venue: string) => group.filter((g) => (!g.artists.length || g.artists.includes(artist)) && g.venue.toLowerCase() !== venue.toLowerCase()).length;
  const anchors = stops
    .filter((s) => s.end >= today)
    .map((s) => ({ s, d: Math.min(...group.map((g) => miles(g.coord, s.coord))), fits: fitsOf(s.artist, s.venue) }))
    .filter((x) => x.d <= ANCHOR_MILES && x.fits > 0)
    .sort((a, b) => b.fits - a.fits || Number(/^confirmed|booked/i.test(b.s.status)) - Number(/^confirmed|booked/i.test(a.s.status)) || a.s.start.localeCompare(b.s.start))
    .slice(0, 4)
    .map(({ s, d }) => ({ artist: s.artist, start: s.start, end: s.end, venue: s.venue, city: s.city, state: s.state, status: s.status, miles: Math.round(d) }));
  const routing = group.filter((g) => g.interest === "if_routing").length;
  let move: string;
  if (anchors.length) {
    const a = anchors[0];
    const fits = fitsOf(a.artist, a.venue);
    const what = a.venue === "Artist's own show" ? `their own show in ${a.city || a.state}` : a.venue;
    const pitched = group.filter((g) => g.pitchedRecently && (!g.artists.length || g.artists.includes(a.artist))).length;
    move = pitched >= Math.ceil(fits / 2)
      ? `Already pitched around ${what} (${a.status}, ${fmtSpan(a.start, a.end)}): ${pitched} of ${fits} are waiting on a reply.`
      : `Pitch the ${fits} that fit ${a.artist} around ${what} (${a.status}, ${fmtSpan(a.start, a.end)}).`;
  } else if (byArtist[0]?.count >= 2) {
    const art = byArtist[0].artist;
    const best = group.filter((g) => g.artists.includes(art)).sort((x, y) => (y.fee ?? 0) - (x.fee ?? 0) || Number(y.interest === "specific_date") - Number(x.interest === "specific_date"))[0];
    move = `${byArtist[0].count} want ${art} with no date yet. Ask ${best.venue} for an offer to anchor a run${windows[0] ? ` (${windows[0]})` : ""}, then route the rest around it.`;
  } else {
    const best = [...group].sort((x, y) => (y.fee ?? 0) - (x.fee ?? 0) || Number(y.interest === "specific_date") - Number(x.interest === "specific_date"))[0];
    const n = routing || group.length;
    move = `${n} ${n === 1 ? "wants" : "want"} roster artists when someone's in the area, but there's no anchor yet. Seed it: ask ${best.venue} for a budget range or which artists interest them most.`;
  }
  return {
    area,
    states,
    venues: group.map(({ id, venue, city, state, interest, artists, window, fee }) => ({ id, venue, city, state, interest, artists, window, fee })),
    byArtist,
    windows,
    anchors,
    move,
  };
}

/** Upcoming calendar stops near a point, soonest first (for the reply drafter). */
export function stopsNear(stops: Stop[], at: Coord, today: string, within = ANCHOR_MILES) {
  return stops
    .filter((s) => s.end >= today)
    .map((s) => ({ ...s, miles: Math.round(miles(s.coord, at)) }))
    .filter((s) => s.miles <= within)
    .sort((a, b) => a.start.localeCompare(b.start));
}
