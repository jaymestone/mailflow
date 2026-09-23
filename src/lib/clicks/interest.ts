import type { SupabaseClient } from "@supabase/supabase-js";

// Which of step 3's three emails a contact should get, based on what they
// genuinely did with step 1.
//
// Reads only clicks already classified as "human" by src/lib/clicks/classify.ts.
// That distinction is the whole feature: 87% of recorded clicks on US
// Venues Roster Announce were mail-security scanners, and naming an artist
// to a venue that never looked at one would be worse than sending nothing.

/** Roster pages live at /agency/<slug>; the roster index itself
 * (/agency, no slug) and the signature link are not artists. Matching on
 * the destination URL rather than the link text because the text is
 * whatever Jayme typed in the markdown -- "KAVITA SHAH" today, something
 * else next campaign -- while the URL shape is structural. */
const ARTIST_URL = /\/agency\/[^/?#]+/;

export type InterestBucket =
  /** Opened 1-3 artists. Name them. */
  | "clicked_focused"
  /** Opened 4 or more -- effectively read the roster. Naming three of ten
   * would be arbitrary, so this variant offers to narrow instead. */
  | "clicked_broad"
  /** Nothing we can stand behind as a real click. */
  | "no_click";

export type ContactInterest = {
  contactId: string;
  bucket: InterestBucket;
  /** Display-cased artist names, first genuinely clicked first, capped at
   * three. Empty for every bucket except clicked_focused. */
  artists: string[];
};

const MAX_NAMED_ARTISTS = 3;

/** "SUMMER CAMARGO" is how the link text is written in the template; it is
 * not how a person writes a name in a sentence. */
export function displayArtistName(label: string): string {
  return label
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word === "&" ? "&" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function bucketFor(artistCount: number): InterestBucket {
  if (artistCount === 0) return "no_click";
  return artistCount <= MAX_NAMED_ARTISTS ? "clicked_focused" : "clicked_broad";
}

type ClickRow = {
  clicked_at: string;
  link_tokens: { contact_id: string | null; label: string; destination_url: string } | null;
};

/** Resolves the bucket for many contacts at once.
 *
 * Batched rather than per-contact because this runs inside the send tick,
 * which has a 22-second self-imposed deadline before cron-job.org's hard
 * kill (see SOFT_DEADLINE_MS) -- twenty sequential click lookups would
 * spend that budget on round trips instead of sends. */
export async function resolveInterest(
  supabase: SupabaseClient,
  campaignId: string,
  contactIds: string[],
): Promise<Map<string, ContactInterest>> {
  const result = new Map<string, ContactInterest>();
  for (const id of contactIds) {
    result.set(id, { contactId: id, bucket: "no_click", artists: [] });
  }
  if (contactIds.length === 0) return result;

  // PostgREST puts .in() lists in the query STRING, so a long one produces
  // a URL the server rejects outright -- it surfaces as an opaque "fetch
  // failed", not as a useful error. Caught by running the preview over a
  // whole campaign (4,058 contacts); the send tick would have hit it too,
  // since CANDIDATE_FETCH_LIMIT lets up to 500 ids through and ~500 UUIDs
  // is already past the practical URL ceiling. 200 keeps each request far
  // inside it. The same payload-size trap is noted on the campaign page.
  const CHUNK = 200;
  const firstClickByContact = new Map<string, Map<string, string>>();

  for (let i = 0; i < contactIds.length; i += CHUNK) {
    // Joined through link_tokens so the campaign and contact filters happen
    // in the database; fetching every click and intersecting in JS would
    // pull tens of thousands of rows to use a few hundred.
    const { data, error } = await supabase
      .from("link_clicks")
      .select("clicked_at, link_tokens!inner(contact_id, label, destination_url)")
      .eq("click_class", "human")
      .eq("link_tokens.campaign_id", campaignId)
      .in("link_tokens.contact_id", contactIds.slice(i, i + CHUNK));

    // A failure here must not silently downgrade everyone to "no_click"
    // and send the wrong email to a genuinely interested venue -- the
    // caller decides what to do, but it has to know.
    if (error) throw new Error(`resolveInterest: ${error.message}`);

    for (const row of (data ?? []) as unknown as ClickRow[]) {
      const token = row.link_tokens;
      if (!token?.contact_id || !ARTIST_URL.test(token.destination_url)) continue;

      if (!firstClickByContact.has(token.contact_id)) firstClickByContact.set(token.contact_id, new Map());
      const perArtist = firstClickByContact.get(token.contact_id)!;
      const existing = perArtist.get(token.label);
      if (!existing || row.clicked_at < existing) perArtist.set(token.label, row.clicked_at);
    }
  }

  for (const [contactId, perArtist] of firstClickByContact) {
    const bucket = bucketFor(perArtist.size);
    const artists =
      bucket === "clicked_focused"
        ? [...perArtist.entries()]
            .sort((a, b) => a[1].localeCompare(b[1]))
            .slice(0, MAX_NAMED_ARTISTS)
            .map(([label]) => displayArtistName(label))
        : [];
    result.set(contactId, { contactId, bucket, artists });
  }

  return result;
}
