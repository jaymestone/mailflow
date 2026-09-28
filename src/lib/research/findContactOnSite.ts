// Recovers a booking address from a venue's own website.
//
// Replaces the paid research path (findReplacement.ts: claude-sonnet-5 plus
// up to 3 server-side web searches per venue, which returned 13 usable
// contacts from 234 venues and produced one mailed address). This does the
// same job deterministically: fetch a handful of predictable pages, read
// the mailto: links, rank what's there.
//
// The property that matters: it can only ever report an address that
// literally appears on one of the venue's pages. It never constructs one
// from a naming convention, which is how the paid path produced
// "first-initial-lastname@northglenn.org" and recorded it as a find.

export type SiteContact = {
  email: string;
  /** booking  = the local part names a booking/programming function
   *  person   = looks like an individual
   *  generic  = info@, hello@, a front desk
   *  boxoffice = ticketing. A DIFFERENT DEPARTMENT from programming, per
   *              Jayme: "this is not at all a good lead." Usable only when
   *              nothing else exists, so it ranks below a front desk —
   *              info@ at least gets routed to whoever should read it.
   *  wrong-desk = a real mailbox at the organisation, but plainly not
   *               about booking music (admissions, alumni giving, HR).
   *               Kept rather than dropped so the miss is visible, but
   *               never offered as the answer.
   */
  kind: "booking" | "person" | "generic" | "boxoffice" | "wrong-desk";
  /** Page it was found on, so the call can be checked by hand. */
  foundOn: string;
};

export type SiteLookup =
  | { found: true; host: string; candidates: SiteContact[]; pagesTried: number }
  | { found: false; host: string; reason: string; pagesTried: number };

/** Paths that actually hold contact details on arts-organisation sites.
 * Ordered by hit rate, because the fetch budget is small. */
export const CANDIDATE_PATHS = [
  "/contact",
  "/contact-us",
  "/staff",
  "/about/staff",
  "/our-staff",
  "/team",
  "/our-team",
  "/about",
  "/about-us",
  "/booking",
];

/** How many pages to fetch per venue before giving up. Kept low: 198
 * venues times a long path list is a lot of requests against small sites. */
export const MAX_PAGES = 6;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Local parts that are never worth mailing. */
const JUNK_LOCAL =
  /^(no-?reply|noreply|donotreply|do-not-reply|postmaster|mailer-daemon|bounce|unsubscribe|abuse|webmaster|privacy|legal|dmca|security|sentry|wordpress|admin|root|test|example|user|name|email|your|someone)$/i;

/** Domains that appear in page markup but aren't the venue. */
const JUNK_DOMAIN =
  /(^|\.)(sentry\.io|wixpress\.com|squarespace\.com|shopify\.com|googleapis\.com|gstatic\.com|w3\.org|schema\.org|example\.com|example\.org|domain\.com|email\.com|sentry-cdn\.com|list-manage\.com|mailchimp\.com|constantcontact\.com|cloudflare\.com|jquery\.com|adobe\.com|fontawesome\.com)$/i;

const BOOKING_LOCAL =
  /^(booking|bookings|book|talent|programming|programme|programs?|program|artistic|artists?|music|entertainment|presenting|productions?|events?)$/i;
const BOOKING_HINT = /(booking|talent|programming|artistic|entertainment)/i;

/** Ticketing, not programming. Kept separate rather than treated as a
 * booking address — which is what this originally did, and it both
 * mis-ranked four venues and stopped the page search early, before
 * /staff could be read. */
const BOXOFFICE_LOCAL = /^(boxoffice|box-office|box_office|tickets?|ticketing|ticketoffice|patronservices|audienceservices|guestservices)$/i;

/** Reduces a host to its registrable-ish root so "tickets.venue.org"
 * counts as the same organisation as "venue.org". Deliberately simple —
 * this only decides whether an address belongs to the venue we're looking
 * at, and a false negative merely discards a candidate. */
export function rootDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  // Handle co.uk / org.uk / com.au style suffixes.
  const twoPart = /^(co|org|com|net|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPart ? -3 : -2).join(".");
}

/** Departments that exist at universities, colleges and large venues and
 * have nothing to do with booking a band. Pitching admissions@ is a wasted
 * send and reads as untargeted. Found by running the scrape over 198 real
 * sites: admissions@eku.edu, admissions@ghc.edu and staffsenate@du.edu all
 * came back ranked as though they were people. */
const WRONG_DESK =
  /^(admissions?|apply|enroll|enrol|registrar|alumni|advancement|development|giving|donate|donations?|philanthropy|hr|humanresources|careers?|jobs|employment|recruiting|payroll|purchasing|accounts?payable|ap|billing|finance|library|athletics|sports|facilities|maintenance|it|helpdesk|parking|police|safety|health|counseling|housing|dining|bookstore|webmaster|media|news|newsletter|subscribe|volunteers?|membership|store|merch|rentals?|weddings?|catering|banquet|privacy|compliance)$/i;

function classify(local: string): SiteContact["kind"] {
  // Checked before the booking patterns: "media" and "rentals" would
  // otherwise slip through some of the hints below.
  if (WRONG_DESK.test(local)) return "wrong-desk";
  if (BOXOFFICE_LOCAL.test(local)) return "boxoffice";
  if (BOOKING_LOCAL.test(local) || BOOKING_HINT.test(local)) return "booking";
  if (/^(info|contact|hello|mail|office|admin|general|enquiries|inquiries|reception|frontdesk|team)$/i.test(local))
    return "generic";
  return "person";
}

/** Pulls every plausible venue address out of a page's HTML. Reads the raw
 * markup rather than rendered text, because arts sites very often hide the
 * address behind a button whose href is a mailto:. */
export function extractEmails(html: string, host: string, foundOn: string): SiteContact[] {
  const root = rootDomain(host);
  const out = new Map<string, SiteContact>();
  for (const m of html.matchAll(EMAIL_RE)) {
    const email = m[0];
    const lower = email.toLowerCase();
    const [local, domain] = lower.split("@");
    if (!local || !domain) continue;
    if (JUNK_LOCAL.test(local)) continue;
    if (JUNK_DOMAIN.test(domain)) continue;
    // Must belong to the venue. An agency's or web designer's address in
    // the footer is not the venue's booking contact.
    if (rootDomain(domain) !== root) continue;
    // Filenames like logo@2x.png slip past the address pattern.
    if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(lower)) continue;
    if (!out.has(lower)) out.set(lower, { email, kind: classify(local), foundOn });
  }
  return [...out.values()];
}

/** Booking first, then a named person, then a front desk. Within a kind,
 * shorter local parts tend to be the real shared mailbox. */
export function rankCandidates(found: SiteContact[]): SiteContact[] {
  const order: Record<SiteContact["kind"], number> = {
    booking: 0,
    person: 1,
    generic: 2,
    boxoffice: 3,
    "wrong-desk": 4,
  };
  return [...found].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.email.length - b.email.length || a.email.localeCompare(b.email),
  );
}

/** Reads a sitemap for paths that look like contact/staff pages, so a site
 * using an unusual path (/connect, /who-we-are) is still reachable. */
export function pathsFromSitemap(xml: string): string[] {
  const hits: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const p = new URL(m[1]).pathname;
      if (/(contact|staff|team|about|people|who-we-are|leadership|booking|connect)/i.test(p)) hits.push(p);
    } catch {
      /* skip malformed */
    }
  }
  return [...new Set(hits)].slice(0, 4);
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: string }>;

/** Looks up one venue. Never throws — a site being down is a normal
 * outcome, not an error worth failing a batch over. */
export async function findContactOnSite(host: string, fetcher: Fetcher): Promise<SiteLookup> {
  const clean = host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  let pagesTried = 0;
  // Tracked separately from pagesTried so "unreachable" means no page ever
  // loaded, rather than just "we made requests" — a dead domain and a site
  // with a contact form but no address are different answers.
  let anyPageLoaded = false;
  const found: SiteContact[] = [];

  // Sitemap first: one cheap request can replace several guesses.
  let paths = [...CANDIDATE_PATHS];
  try {
    pagesTried++;
    const sm = await fetcher(`https://${clean}/sitemap.xml`);
    if (sm.ok) anyPageLoaded = true;
    if (sm.ok && /<loc>/i.test(sm.text)) {
      const discovered = pathsFromSitemap(sm.text);
      paths = [...new Set([...discovered, ...CANDIDATE_PATHS])];
    }
  } catch {
    /* no sitemap is normal */
  }

  for (const path of paths) {
    if (pagesTried >= MAX_PAGES) break;
    pagesTried++;
    try {
      const res = await fetcher(`https://${clean}${path}`);
      if (!res.ok) continue;
      anyPageLoaded = true;
      found.push(...extractEmails(res.text, clean, path));
      // Only a real booking address is worth stopping for. Stopping on a
      // box office address meant /staff was never read, so a venue whose
      // programmer is listed there was reduced to its ticketing desk.
      if (found.some((f) => f.kind === "booking")) break;
    } catch {
      continue;
    }
  }

  if (found.length === 0) {
    return {
      found: false,
      host: clean,
      reason: anyPageLoaded ? "no address on any page tried" : "site unreachable",
      pagesTried,
    };
  }
  // Dedupe across pages, keeping the first page each was seen on.
  const seen = new Map<string, SiteContact>();
  for (const f of found) if (!seen.has(f.email.toLowerCase())) seen.set(f.email.toLowerCase(), f);
  return { found: true, host: clean, candidates: rankCandidates([...seen.values()]), pagesTried };
}
