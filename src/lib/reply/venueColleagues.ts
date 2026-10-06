import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReplyCategory } from "./types";

/** Once anyone at a venue has answered a campaign, the venue has answered.
 *
 * Mailflow used to stop mailing only the one record the reply matched, so
 * everyone else filed under the same venue kept receiving the sequence.
 * Two live cases on 2026-10-06: Celene Lyon (Old Sloop) and Michael
 * Kornfeld (Huntington) each replied, then wrote again a week later to
 * point out that a second and third record for them were still sending.
 * The same sweep found 72 colleagues at venues that had already replied --
 * eight people at Texas A&M after one of them said yes.
 *
 * Jayme's rule: if someone has replied from a venue, pause the others in
 * that campaign. Pausing, not deleting, so a colleague can be resumed by
 * hand if the reply turns out not to speak for the venue. */

/** Venues whose programmers each run their own series and book
 * independently, so one reply speaks only for its writer. Lincoln Center
 * has nine on the list. Add to this as Jayme names more; the name is
 * compared after normVenue, so spacing, case and punctuation don't matter. */
const INDEPENDENT_PROGRAMMER_VENUES = ["Lincoln Center for the Performing Arts"];

/** Replies a person actually wrote. Auto-replies, bounces and spam say
 * nothing about the venue, and "unclear" covers "wrong person", which is
 * a statement about one address, not about everyone there. */
const HUMAN_REPLIES = new Set<ReplyCategory>(["interested", "not_interested", "follow_up", "opt_out"]);

export function speaksForVenue(category: ReplyCategory): boolean {
  return HUMAN_REPLIES.has(category);
}

type VenueFields = { email: string; venue: string | null; city: string | null; state: string | null };

function normVenue(v: string | null): string {
  return (v ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Letters NFKD leaves whole: "Tønder" and "Tonder" are one festival.
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/ł/g, "l")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function normPlace(v: string | null): string {
  return (v ?? "").trim().toLowerCase();
}

/** Blank counts as agreeing, since many rows have no city; two different
 * filled-in values never do. */
function placesAgree(a: string | null, b: string | null): boolean {
  const x = normPlace(a);
  const y = normPlace(b);
  return !x || !y || x === y;
}

const INDEPENDENT = new Set(INDEPENDENT_PROGRAMMER_VENUES.map(normVenue));

export function programsIndependently(venue: string | null): boolean {
  return INDEPENDENT.has(normVenue(venue));
}

/** Same venue: the same name in the same place. The place check is what
 * keeps the many "Grand Theatre"s and "Capitol Theatre"s apart.
 *
 * A shared email domain deliberately does not count. It was tried, and at
 * a university it pulled in people with nothing to do with the series that
 * replied: a Wake Forest dance professor was paused because the Secrest
 * Artists Series said no. */
export function isSameVenue(a: VenueFields, b: VenueFields): boolean {
  const va = normVenue(a.venue);
  return !!va && va === normVenue(b.venue) && placesAgree(a.city, b.city) && placesAgree(a.state, b.state);
}

/** Pauses every other active member of this campaign at the replying
 * contact's venue. Returns how many were paused. Must run before the reply
 * path deletes the contact (opt_out), since it reads the contact's venue. */
export async function pauseVenueColleagues(
  supabase: SupabaseClient,
  contactId: string,
  campaignId: string,
): Promise<number> {
  const { data: replier } = await supabase
    .from("contacts")
    .select("email, venue, city, state")
    .eq("id", contactId)
    .maybeSingle();
  if (!replier || programsIndependently(replier.venue)) return 0;

  const { data: members } = await supabase
    .from("campaign_members")
    .select("id, contact_id, contacts(email, venue, city, state)")
    .eq("campaign_id", campaignId)
    .eq("member_status", "active")
    .neq("contact_id", contactId);

  const ids = (members ?? [])
    .filter((m) => {
      const c = (Array.isArray(m.contacts) ? m.contacts[0] : m.contacts) as VenueFields | null;
      return c && isSameVenue(replier as VenueFields, c);
    })
    .map((m) => m.id as string);
  if (ids.length === 0) return 0;

  const { data: paused } = await supabase
    .from("campaign_members")
    .update({ member_status: "paused" })
    .in("id", ids)
    .eq("member_status", "active")
    .select("id");
  return paused?.length ?? 0;
}
