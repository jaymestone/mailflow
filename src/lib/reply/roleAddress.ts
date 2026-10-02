/** Is this a shared/role mailbox rather than one person's address?
 *
 * It matters on a departure. When a reply says someone has left, Mailflow
 * suppresses the sending address and deletes the contact -- correct for
 * sarah.jones@venue.org, and destructive for festival@venue.org, which
 * outlives whoever happened to be reading it.
 *
 * This is not hypothetical. Goderich Celtic Roots Festival had a contact
 * record named "Eleanor Robinson" carrying the festival's own shared
 * address. The Artistic Director wrote from it to say Eleanor had not
 * been involved for fifteen years; Mailflow read a departure, deleted the
 * contact, and suppressed festival@celticfestival.ca -- permanently
 * blocking the one address the festival had asked to be used, while the
 * two personal addresses it had asked to be removed stayed active and
 * kept receiving the sequence.
 *
 * The exposure comes from the research standard that allows a real name
 * paired with a shared inbox as a last resort. Every contact filed that
 * way carries the same hazard: one departure burns the venue's main
 * address.
 */

/** Local parts that are a function rather than a person. Deliberately
 * conservative -- a false positive only means a departure gets flagged
 * for Jayme instead of actioned automatically, while a false negative
 * silently burns a venue's main address. */
const ROLE_LOCAL_PARTS = new Set([
  "info", "booking", "bookings", "contact", "admin", "office", "mail", "email",
  "hello", "hi", "general", "enquiries", "inquiries", "tickets", "boxoffice",
  "box office", "festival", "events", "programming", "program", "music",
  "artistic", "talent", "press", "media", "marketing", "support", "help",
  "team", "staff", "reception", "frontdesk", "main", "contactus", "connect",
  "submissions", "submit", "apply", "applications", "schedule", "calendar",
  "theatre", "theater", "venue", "club", "arts", "concerts", "manager",
]);

/** Prefixes that make a local part a role even with something appended,
 * e.g. booking-jazz@, info.uk@, tickets2026@. */
const ROLE_PREFIXES = [
  "info", "booking", "contact", "office", "tickets", "boxoffice", "festival",
  "events", "programming", "press", "submissions", "admin",
];

export function isRoleAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.indexOf("@");
  if (at <= 0) return false;

  const local = email
    .slice(0, at)
    .toLowerCase()
    .trim()
    // Gmail-style tags and common separators are noise for this question.
    .replace(/\+.*$/, "");

  if (ROLE_LOCAL_PARTS.has(local)) return true;
  // Normalised form: booking_office / booking-office / booking.office.
  const squashed = local.replace(/[._-]/g, "");
  if (ROLE_LOCAL_PARTS.has(squashed)) return true;

  return ROLE_PREFIXES.some((p) => squashed.startsWith(p));
}
