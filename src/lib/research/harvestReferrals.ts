import type { SupabaseClient } from "@supabase/supabase-js";
import { parseReferral, type Referral } from "./parseReferral";

// Turns the successors that venues already named in their own departure
// auto-replies into contacts awaiting approval.
//
// Deliberately different from replacementTick.ts in one respect: that path
// inserts a found contact AND enrolls it into the departed person's
// campaigns straight away, so an unreviewed address starts receiving the
// sequence. Nothing here enrolls anything. Harvested contacts land in a
// review list with no campaign membership, which makes them inert — the
// send query only ever considers campaign_members.

export const PENDING_LIST_NAME = "Referrals — pending approval";

/** Only a departure means the person is actually gone. A holiday
 * auto-reply names a colleague covering for a fortnight, and treating that
 * as a replacement would swap a real contact for someone who never asked
 * for the pitch. 454 temporary replies in the list carry such a name. */
const HARVEST_FROM = ["ooo_departed"] as const;

export type HarvestCandidate = {
  email: string;
  firstName: string;
  lastName: string | null;
  venue: string | null;
  venueType: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  listId: string | null;
  /** Address whose departure reply named this person. */
  referredBy: string;
  referral: Referral;
};

export type HarvestReport = {
  repliesScanned: number;
  referralsFound: number;
  /** Rejected because the address is already a contact. */
  alreadyContact: number;
  /** Rejected because the address is suppressed. */
  suppressed: number;
  /** Rejected as a duplicate within this run. */
  duplicate: number;
  /** Accepted, but we could not establish which venue they belong to. */
  withoutVenue: number;
  inserted: number;
  candidates: HarvestCandidate[];
  errors: string[];
};

/** Jayme's convention for a contact whose name we don't know. The template
 * resolver would otherwise render "there" (see src/lib/templates/resolve.ts),
 * and the existing list already uses "Folks" throughout. */
export const NO_NAME = "Folks";

/** Splits "Mallory Wright" into name fields. Referral names come from
 * prose, so treat anything beyond two words as a single surname rather
 * than guessing at middle names. A referral often gives us only an
 * address, so first_name falls back to NO_NAME rather than null. */
export function splitName(name: string | null): { firstName: string; lastName: string | null } {
  if (!name) return { firstName: NO_NAME, lastName: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** A name parsed out of prose is sometimes a job title rather than a
 * person ("Interim Director", "Adult Enrichment"). Keep the address, drop
 * the name, rather than writing a title into first_name. */
const TITLE_WORDS =
  /\b(director|manager|coordinator|assistant|associate|interim|executive|programming|enrichment|office|department|team|committee|transition|services|booking|marketing|education|president|chair|admin)\b/i;

export function cleanReferralName(name: string | null): string | null {
  if (!name) return null;
  if (TITLE_WORDS.test(name)) return null;
  return name;
}

/** Builds the insert rows. Pure, so the shaping is testable without a
 * database and without the network. */
export function shapeContactRows(candidates: HarvestCandidate[], pendingListId: string) {
  return candidates.map((c) => ({
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    venue: c.venue,
    venue_type: c.venueType,
    city: c.city,
    state: c.state,
    country: c.country,
    // Review list, NOT the list the departed contact was on. Moving them
    // across is the approval step.
    list_id: pendingListId,
    source: `Referral from ${c.referredBy} (departure auto-reply)`,
    notes: [
      `PENDING APPROVAL — named by ${c.referredBy}'s own departure reply, confidence ${c.referral.confidence}${
        c.referral.isRoleAddress ? ", role address rather than a named person" : ""
      }.`,
      `Their words: "${c.referral.evidence}"`,
      c.listId ? `Departed contact's list: ${c.listId}` : `No list known for the departed contact.`,
      `Not enrolled in any campaign. Move to the right list and add to a campaign to approve.`,
    ].join("\n"),
  }));
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Pages past PostgREST's 1000-row cap. The caller builds each page's
 * query so the row type stays inferred rather than cast. */
async function pageAll<T>(build: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 500;
  for (let p = 0; ; p++) {
    const { data, error } = await build(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw new Error(`harvestReferrals: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/** Finds the list/venue context for a departed address — from the
 * replacement queue first, since the contact row is usually gone by now. */
async function venueContextFor(supabase: SupabaseClient, email: string) {
  const { data: q } = await supabase
    .from("replacement_queue")
    .select("venue, venue_type, city, state, country, list_id")
    .ilike("removed_contact_email", email)
    .limit(1)
    .maybeSingle();
  if (q) return q as Record<string, string | null>;

  const { data: c } = await supabase
    .from("contacts")
    .select("venue, venue_type, city, state, country, list_id")
    .ilike("email", email)
    .limit(1)
    .maybeSingle();
  if (c) return c as Record<string, string | null>;

  // Last resort: a colleague on the same domain. dasbell@lobero.org is
  // plainly the Lobero Theatre even after his contact row is deleted and
  // no queue row exists, and a contact with no venue is nearly useless to
  // review. Skipped for free-mail domains, where a shared domain says
  // nothing about a shared employer.
  const dom = email.toLowerCase().split("@")[1];
  if (!dom || FREE_MAIL.has(dom)) return null;
  const { data: sibling } = await supabase
    .from("contacts")
    .select("venue, venue_type, city, state, country, list_id")
    .ilike("email", `%@${dom}`)
    .not("venue", "is", null)
    .limit(1)
    .maybeSingle();
  return (sibling ?? null) as Record<string, string | null> | null;
}

/** Domains where two addresses sharing them implies nothing. */
export const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "cox.net",
  "sbcglobal.net",
  "windstream.net",
  "msn.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
]);

/** Ensures the review list exists and returns its id. */
export async function ensurePendingList(supabase: SupabaseClient): Promise<string> {
  const { data: existing } = await supabase.from("lists").select("id").eq("name", PENDING_LIST_NAME).maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await supabase
    .from("lists")
    .insert({
      name: PENDING_LIST_NAME,
      description:
        "Successors named in departure auto-replies, harvested from replies already in the inbox. Nothing here is in a campaign. Approve by moving a contact to its proper list and adding it to a campaign.",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`harvestReferrals: could not create list — ${error?.message}`);
  return (data as { id: string }).id;
}

export async function harvestReferrals(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean } = {},
): Promise<HarvestReport> {
  const report: HarvestReport = {
    repliesScanned: 0,
    referralsFound: 0,
    alreadyContact: 0,
    suppressed: 0,
    duplicate: 0,
    withoutVenue: 0,
    inserted: 0,
    candidates: [],
    errors: [],
  };

  const replies = await pageAll<{ from_email: string; body_text: string }>((from, to) =>
    supabase
      .from("inbound_messages")
      .select("from_email, body_text")
      .in("classification_category", HARVEST_FROM)
      .range(from, to),
  );
  report.repliesScanned = replies.length;

  // One fetch each rather than per-candidate round trips.
  const contactEmails = new Set(
    (await pageAll<{ email: string }>((from, to) => supabase.from("contacts").select("email").range(from, to))).map(
      (c) => c.email.toLowerCase(),
    ),
  );
  const suppressedEmails = new Set(
    (await pageAll<{ email: string }>((from, to) => supabase.from("suppression").select("email").range(from, to))).map(
      (s) => s.email.toLowerCase(),
    ),
  );

  const seen = new Set<string>();
  for (const r of replies) {
    const referral = parseReferral(r.body_text, { senderEmail: r.from_email });
    if (!referral) continue;
    report.referralsFound++;

    const email = referral.email.toLowerCase();
    if (seen.has(email)) {
      report.duplicate++;
      continue;
    }
    seen.add(email);
    if (contactEmails.has(email)) {
      report.alreadyContact++;
      continue;
    }
    if (suppressedEmails.has(email)) {
      report.suppressed++;
      continue;
    }

    const ctx = await venueContextFor(supabase, r.from_email);
    if (!ctx?.venue) report.withoutVenue++;
    const { firstName, lastName } = splitName(cleanReferralName(referral.name));

    report.candidates.push({
      email: referral.email,
      firstName,
      lastName,
      venue: ctx?.venue ?? null,
      venueType: ctx?.venue_type ?? null,
      city: ctx?.city ?? null,
      state: ctx?.state ?? null,
      country: ctx?.country ?? null,
      listId: ctx?.list_id ?? null,
      referredBy: r.from_email,
      referral,
    });
  }

  if (opts.dryRun) return report;

  const listId = await ensurePendingList(supabase);
  const rows = shapeContactRows(report.candidates, listId);
  // Chunked because a single large insert is the kind of payload that
  // fails opaquely against PostgREST.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("contacts")
      .insert(rows.slice(i, i + CHUNK))
      .select("id");
    if (error) {
      report.errors.push(error.message);
      continue;
    }
    report.inserted += (data ?? []).length;
  }
  return report;
}

/** Single-reply version, for the reply tick.
 *
 * The batch harvest above scans history; this runs the moment a departure
 * arrives so the pending list fills itself. Same safety property: the
 * contact is created with no campaign membership, so nothing can send to
 * it until a human moves it into a campaign.
 *
 * Returns the inserted email, or null when the reply named nobody usable. */
export async function harvestReferralFromReply(
  supabase: SupabaseClient,
  args: {
    body: string;
    senderEmail: string;
    /** The departing contact, for venue/list context. */
    venueContext: {
      venue?: string | null;
      venue_type?: string | null;
      city?: string | null;
      state?: string | null;
      country?: string | null;
      list_id?: string | null;
    } | null;
  },
): Promise<string | null> {
  const referral = parseReferral(args.body, { senderEmail: args.senderEmail });
  if (!referral) return null;

  const email = referral.email.toLowerCase();
  const [{ data: existing }, { data: suppressed }] = await Promise.all([
    supabase.from("contacts").select("id").ilike("email", email).maybeSingle(),
    supabase.from("suppression").select("email").ilike("email", email).maybeSingle(),
  ]);
  if (existing || suppressed) return null;

  const { firstName, lastName } = splitName(cleanReferralName(referral.name));
  const listId = await ensurePendingList(supabase);
  const [row] = shapeContactRows(
    [
      {
        email: referral.email,
        firstName,
        lastName,
        venue: args.venueContext?.venue ?? null,
        venueType: args.venueContext?.venue_type ?? null,
        city: args.venueContext?.city ?? null,
        state: args.venueContext?.state ?? null,
        country: args.venueContext?.country ?? null,
        listId: args.venueContext?.list_id ?? null,
        referredBy: args.senderEmail,
        referral,
      },
    ],
    listId,
  );

  const { error } = await supabase.from("contacts").insert(row);
  if (error) return null;
  return referral.email;
}
