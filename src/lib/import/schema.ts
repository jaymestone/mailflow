// The 13-column venue schema shared by every contact tab in the old
// spreadsheet. Header matching is case-insensitive and ignores whitespace.
export const CONTACT_COLUMNS = [
  { key: "first_name", headers: ["First Name"] },
  { key: "last_name", headers: ["Last Name"] },
  { key: "email", headers: ["Email"] },
  { key: "venue", headers: ["Venue"] },
  { key: "venue_type", headers: ["Venue Type"] },
  { key: "city", headers: ["City"] },
  { key: "state", headers: ["State"] },
  { key: "country", headers: ["Country"] },
  { key: "notes", headers: ["Notes"] },
  { key: "source", headers: ["Source"] },
  { key: "mobile", headers: ["Mobile"] },
  { key: "phone", headers: ["Phone"] },
  { key: "website", headers: ["Website"] },
] as const;

export type ContactKey = (typeof CONTACT_COLUMNS)[number]["key"];

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

const HEADER_TO_KEY = new Map<string, ContactKey>(
  CONTACT_COLUMNS.flatMap((col) =>
    col.headers.map((h) => [normalizeHeader(h), col.key] as const),
  ),
);

export function resolveHeaderKey(header: string): ContactKey | null {
  return HEADER_TO_KEY.get(normalizeHeader(header)) ?? null;
}

// Non-contact tabs in the old workbook that should never be imported as venues.
export const NON_CONTACT_SHEET_NAMES = new Set(
  [
    "README",
    "Campaigns",
    "Campaign Members",
    "Templates",
    "Send Counters",
    "Suppression",
    "Email Log",
    // Internal research/lead-finding scratch tabs, not curated contact
    // lists — some of these have their own "email" column, so without this
    // exclusion they'd otherwise pass the "has an Email column" contact-tab
    // check and get imported as junk lists.
    "ZZ_FOUND",
    "ZZ_QUEUE",
    "ZZ_PEOPLE",
    "ZZ_DOMAINS",
  ].map((s) => s.toLowerCase()),
);
