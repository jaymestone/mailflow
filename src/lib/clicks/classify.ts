// Telling a venue's real interest apart from their mail server's malware
// scanner.
//
// The original detection (src/lib/send/botDetection.ts) asks two questions
// of a single click in isolation: does the user-agent name a known scanner,
// and did it land within 10 seconds of the send. Both are sound, and both
// miss most of the traffic -- measured against production on 2026-09-23, it
// flagged 497 of 26,215 clicks (1.9%) while the true scanner share was
// closer to 85%.
//
// It misses them because modern scanners spoof ordinary browser
// user-agents (Outlook Safe Links reports itself as Windows Chrome), and
// because they are not as fast as 10 seconds -- the measured median first
// touch was 41-70 seconds after send. What actually gives them away is
// only visible when a contact's clicks are looked at TOGETHER:
//
//   clicked 1 artist   214 contacts   first click ~6 min after send
//   clicked 2 artists   41 contacts   both within 41s, ~6 min after send
//   clicked 3 artists   30 contacts   spread over 4 min, ~12 min after send
//   clicked 8+       1,584 contacts   ALL of them within 5-10 SECONDS,
//                                     starting ~60 seconds after send
//
// No human opens an email one minute after it arrives and visits eight
// artist pages in five seconds. That bottom row is machinery, and it was
// drowning the 200-odd real signals in ~1,600 fake ones.
//
// So this classifier works on a contact's clicks as a set, not one at a
// time, and it classifies each click individually within that context --
// a scanner burst at T+40s and a genuine click three days later can and
// should come out differently, because that contact really did look.

import { looksLikeBotUserAgent } from "../send/botDetection";

export type ClickClass = "human" | "scanner" | "uncertain";

export type RawClick = {
  /** link_clicks.id -- the click itself. A single token can be clicked
   * many times (a scanner re-fetching, a person coming back), so the token
   * does NOT identify a click and cannot be the key here. */
  id: string;
  token: string;
  /** The artist (or other link) this token pointed at. */
  label: string;
  clickedAt: string;
  /** When the token was minted, which is effectively when the mail was sent. */
  tokenCreatedAt: string;
  userAgent: string | null;
};

export type ClassifiedClick = {
  id: string;
  token: string;
  clickedAt: string;
  clickClass: ClickClass;
  /** Human-readable justification, stored so a surprising call can be audited. */
  reason: string;
};

// A human who opens a mail the moment it lands still has to read enough of
// it to decide to click. Measured: real single-artist clickers first
// clicked a median of ~6 minutes after send; scanners a median of ~41-70
// seconds. 90s sits clearly between the two populations rather than
// splitting either, and is deliberately generous to the human side --
// anything faster than this is treated as suspect, not as interest.
const HUMAN_MIN_DELAY_MS = 90_000;

// A burst is several DIFFERENT links hit in one near-instant window --
// the single strongest signal available, since the 8+ artist group's
// median span for ALL their clicks was 4.9 seconds (roughly 0.6s between
// links).
//
// The window has to be tight, and a unit test is what proved how tight.
// At a ±120s window the rule condemned a genuine 3-artist browser clicking
// every 2 minutes: the middle click sees both neighbours and trips the
// threshold. Measured human inter-click gaps are tens of seconds (41s
// between two artists, ~80s between three), against sub-second for
// scanners, so 20s sits an order of magnitude clear of both.
//
// A person deliberately middle-clicking three artists into tabs inside 20
// seconds would be misread -- accepted knowingly. Naming an artist someone
// never looked at costs far more than staying quiet about one they did,
// and such a contact's later, slower clicks are still classified on their
// own merits.
const BURST_WINDOW_MS = 20_000;
const BURST_MIN_DISTINCT_LABELS = 3;

// The burst rule needs three links, and validating against production
// showed what slips underneath it: scanners that fetch only TWO links per
// visit and come back repeatedly over days. Sixty-six contacts appeared to
// have genuinely opened nine or ten artists; a third of them turned out to
// be pairs of different artists hit 0.2 SECONDS apart, restarting every
// day or so for a fortnight.
//
// No human clicks two different artist pages a fifth of a second apart, at
// any count, so this needs no third link to be certain. It is the same
// machine-pacing idea as the burst rule at a smaller scale: two distinct
// labels closer together than a person could physically act.
const MACHINE_PACED_GAP_MS = 2_000;

/** Classifies every click for ONE contact within ONE campaign. Pass the
 * contact's complete click history for that campaign -- the group context
 * is what makes the call possible, so a partial set will under-detect. */
export function classifyClicks(clicks: RawClick[]): ClassifiedClick[] {
  if (clicks.length === 0) return [];

  const ordered = [...clicks].sort(
    (a, b) => new Date(a.clickedAt).getTime() - new Date(b.clickedAt).getTime(),
  );
  const distinctLabelsOverall = new Set(ordered.map((c) => c.label)).size;

  return ordered.map((click) => {
    const clickedMs = new Date(click.clickedAt).getTime();
    const delayMs = clickedMs - new Date(click.tokenCreatedAt).getTime();

    // 1. Self-identified scanner. Cheapest and least arguable.
    if (click.userAgent && looksLikeBotUserAgent(click.userAgent)) {
      return { ...pick(click), clickClass: "scanner" as const, reason: "user-agent identifies a scanner" };
    }

    // 2. Part of a burst: several distinct links hit around the same
    //    moment. Evaluated as a window AROUND this click rather than from
    //    the send, so repeat scans days later are caught the same way the
    //    first one is.
    const nearby = new Set(
      ordered
        .filter((other) => Math.abs(new Date(other.clickedAt).getTime() - clickedMs) <= BURST_WINDOW_MS)
        .map((other) => other.label),
    );
    if (nearby.size >= BURST_MIN_DISTINCT_LABELS) {
      return {
        ...pick(click),
        clickClass: "scanner" as const,
        reason: `${nearby.size} different links hit within ${BURST_WINDOW_MS / 1000}s of each other`,
      };
    }

    // 3. Machine pacing: a different link hit within a couple of seconds
    //    of this one. Needs no third link to be conclusive.
    const pacedWith = ordered.find(
      (other) =>
        other.label !== click.label &&
        Math.abs(new Date(other.clickedAt).getTime() - clickedMs) <= MACHINE_PACED_GAP_MS,
    );
    if (pacedWith) {
      const gap = Math.abs(new Date(pacedWith.clickedAt).getTime() - clickedMs) / 1000;
      return {
        ...pick(click),
        clickClass: "scanner" as const,
        reason: `another link hit ${gap.toFixed(1)}s away — faster than a person can click`,
      };
    }

    // 4. Too soon after the send to be a person reading. On its own this
    //    is suggestive rather than conclusive, so it only condemns the
    //    click outright when the contact also touched more than one link;
    //    a lone fast click stays "uncertain" and is simply not counted as
    //    interest.
    if (delayMs < HUMAN_MIN_DELAY_MS) {
      const secs = Math.round(delayMs / 1000);
      return distinctLabelsOverall > 1
        ? {
            ...pick(click),
            clickClass: "scanner" as const,
            reason: `clicked ${secs}s after send, one of ${distinctLabelsOverall} links touched`,
          }
        : { ...pick(click), clickClass: "uncertain" as const, reason: `clicked only ${secs}s after send` };
    }

    return {
      ...pick(click),
      clickClass: "human" as const,
      reason: `clicked ${formatDelay(delayMs)} after send, no burst pattern`,
    };
  });
}

function pick(click: RawClick) {
  return { id: click.id, token: click.token, clickedAt: click.clickedAt };
}

function formatDelay(ms: number): string {
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.round(mins)} min`;
  const hours = mins / 60;
  return hours < 48 ? `${hours.toFixed(1)} hr` : `${Math.round(hours / 24)} days`;
}

export type ArtistInterest = {
  label: string;
  /** How many genuine clicks this artist got from this contact. */
  clicks: number;
  /** First genuine click, which is the ordering Jayme asked for. */
  firstClickedAt: string;
};

/** The artists a contact genuinely looked at, strongest first.
 *
 * Ordered by when they were FIRST clicked -- Jayme's stated preference, on
 * the reasoning that the first thing someone opens is the thing the
 * subject line or the roster order actually caught them on. Click count
 * comes back alongside it (and breaks ties) so the ordering can be flipped
 * to count-first later without recomputing anything. */
export function rankClickedArtists(
  classified: ClassifiedClick[],
  clicks: RawClick[],
  opts: { limit?: number; artistLabels?: Set<string> } = {},
): ArtistInterest[] {
  const humanClickIds = new Set(classified.filter((c) => c.clickClass === "human").map((c) => c.id));
  const byLabel = new Map<string, ArtistInterest>();

  for (const click of clicks) {
    if (!humanClickIds.has(click.id)) continue;
    if (opts.artistLabels && !opts.artistLabels.has(click.label)) continue;

    const existing = byLabel.get(click.label);
    if (!existing) {
      byLabel.set(click.label, { label: click.label, clicks: 1, firstClickedAt: click.clickedAt });
      continue;
    }
    existing.clicks++;
    if (click.clickedAt < existing.firstClickedAt) existing.firstClickedAt = click.clickedAt;
  }

  const ranked = [...byLabel.values()].sort((a, b) => {
    const byTime = a.firstClickedAt.localeCompare(b.firstClickedAt);
    return byTime !== 0 ? byTime : b.clicks - a.clicks;
  });

  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}
