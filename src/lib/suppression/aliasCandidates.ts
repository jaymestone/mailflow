import type { SupabaseClient } from "@supabase/supabase-js";

// Suppressing an address does not stop mail to the same person at a
// different domain.
//
// The send engine gates on `lower(suppression.email) = lower(contacts.email)`
// (see the due-members query in migration 33). So when an organisation has
// migrated domains, the address a person REPLIES from is often not the
// address we hold and mail. Suppressing the reply address looks correct,
// reports success, and blocks nothing.
//
// This has happened three times in four days on real removals:
//   Rubin Museum      we mailed tmchenry@rmanyc.org,  he replies from tmchenry@rubinmuseum.org
//   Mondavi Center    we mailed rgreenwald@ucdavis.edu (same domain, caught by venue instead)
//   Peabody Auditorium we mailed SmithChad@codb.us,   he replies from SmithChad@daytonabeach.gov
//
// Each was caught by hand. This turns that into a prompt.

export type AliasCandidate = {
  contactId: string;
  email: string;
  name: string | null;
  venue: string | null;
  /** "exact" = identical local part. "loose" = identical once dots,
   * hyphens and underscores are removed, which catches the
   * first.last@ vs firstlast@ convention change. */
  match: "exact" | "loose";
};

export type AliasWarning = {
  /** The address being suppressed. */
  suppressing: string;
  /** Contacts that look like the same person on a different domain. */
  candidates: AliasCandidate[];
};

const localPart = (email: string) => email.toLowerCase().split("@")[0] ?? "";
const domain = (email: string) => email.toLowerCase().split("@")[1] ?? "";
/** Collapses convention differences: "smith.chad" and "smithchad" agree. */
const loosen = (local: string) => local.replace(/[.\-_]/g, "");

/** Local parts too generic to be a person. Matching on these would flag
 * every info@ in the list against every other info@, which is noise, not
 * a signal. */
const ROLE_LOCAL_PARTS = new Set([
  "info",
  "booking",
  "bookings",
  "music",
  "events",
  "contact",
  "office",
  "admin",
  "tickets",
  "boxoffice",
  "box-office",
  "hello",
  "mail",
  "arts",
  "concerts",
  "program",
  "programs",
  "programming",
  "director",
  "talent",
  "press",
  "marketing",
  "general",
  "frontdesk",
  "reception",
  "theatre",
  "theater",
]);

/** A local part only identifies a person if it carries their surname.
 *
 * Found by running the first version over the live list: a great many
 * venues use firstname@venue.com, so matching on the local part alone
 * flagged `jeff@nelsonodeon.com` against eight unrelated Jeffs, and
 * produced 289 "duplicate" groups that were almost all noise. Requiring
 * the candidate's own surname to appear in the local part keeps every
 * real case (tmchenry/McHenry, rgreenwald/Greenwald, SmithChad/Smith)
 * and drops the first-name collisions.
 *
 * Four characters because "Ng" or "Lee" inside a longer local part is
 * coincidence more often than not. */
const MIN_SURNAME_LEN = 4;

function surnameCorroborates(localPartLoose: string, lastName: string | null): boolean {
  const surname = (lastName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (surname.length < MIN_SURNAME_LEN) return false;
  return localPartLoose.includes(surname);
}

type ContactRow = { id: string; email: string; first_name: string | null; last_name: string | null; venue: string | null };

/** Fetches every contact email once, paging past PostgREST's 1000-row cap. */
async function allContacts(supabase: SupabaseClient): Promise<ContactRow[]> {
  const out: ContactRow[] = [];
  const PAGE = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, email, first_name, last_name, venue")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`aliasCandidates: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as ContactRow[]));
    if (data.length < PAGE) break;
  }
  return out;
}

/** Given addresses about to be suppressed, finds contacts that look like
 * the same person at a different domain and are NOT themselves being
 * suppressed in this batch.
 *
 * Returns only addresses that have candidates, so an empty array means
 * "nothing to worry about" and the caller can stay quiet. */
export function matchAliases(
  suppressing: string[],
  contacts: ContactRow[],
): AliasWarning[] {
  const batch = new Set(suppressing.map((e) => e.toLowerCase()));
  const warnings: AliasWarning[] = [];

  for (const raw of suppressing) {
    const email = raw.toLowerCase();
    const local = localPart(email);
    if (!local || ROLE_LOCAL_PARTS.has(local)) continue;

    const dom = domain(email);
    const loose = loosen(local);
    const candidates: AliasCandidate[] = [];

    for (const c of contacts) {
      const cEmail = (c.email ?? "").toLowerCase();
      if (!cEmail || batch.has(cEmail)) continue; // already handled
      if (domain(cEmail) === dom) continue; // same domain is not an alias
      const cLocal = localPart(cEmail);
      const exact = cLocal === local;
      const looseHit = !exact && loosen(cLocal) === loose;
      if (!exact && !looseHit) continue;
      // The local parts agree -- but that only means something if the
      // local part actually names this person. See MIN_SURNAME_LEN.
      if (!surnameCorroborates(loosen(cLocal), c.last_name)) continue;
      candidates.push({
        contactId: c.id,
        email: c.email,
        name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
        venue: c.venue,
        match: exact ? "exact" : "loose",
      });
    }

    if (candidates.length > 0) warnings.push({ suppressing: raw, candidates });
  }
  return warnings;
}

/** Convenience wrapper that does the fetch. Kept separate from
 * matchAliases so the matching is testable without a database. */
export async function findAliasCandidates(
  supabase: SupabaseClient,
  suppressing: string[],
): Promise<AliasWarning[]> {
  if (suppressing.length === 0) return [];
  // Skip the table scan entirely when every address is a role account.
  const worthChecking = suppressing.filter((e) => {
    const l = localPart(e);
    return l && !ROLE_LOCAL_PARTS.has(l);
  });
  if (worthChecking.length === 0) return [];
  return matchAliases(worthChecking, await allContacts(supabase));
}
