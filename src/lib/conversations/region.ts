/** Maps a contact's state/country onto a touring region.
 *
 * Regions rather than states because routing is what the column is for --
 * fifty options cannot be grouped by, and "who else is near this venue"
 * is the question being asked of it.
 *
 * Handles both forms found in the contacts table: two-letter codes (the
 * majority) and full names ("Pennsylvania"), since imports arrived from
 * several sources over time. Also handles the literal "--" placeholder a
 * research pass wrote into state for region-wide organisations.
 */

export type Region =
  | "Northeast"
  | "Southeast"
  | "Midwest"
  | "Mountain West"
  | "Southwest"
  | "West Coast"
  | "Canada"
  | "Europe"
  | "Other";

const BY_REGION: Record<Exclude<Region, "Canada" | "Europe" | "Other">, string[]> = {
  Northeast: ["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA"],
  Southeast: ["DE", "MD", "DC", "VA", "WV", "NC", "SC", "GA", "FL", "AL", "MS", "TN", "KY", "AR", "LA"],
  Midwest: ["OH", "IN", "IL", "MI", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"],
  "Mountain West": ["MT", "ID", "WY", "CO", "UT", "NV"],
  Southwest: ["AZ", "NM", "TX", "OK"],
  "West Coast": ["WA", "OR", "CA", "AK", "HI"],
};

const FULL_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "washington dc": "DC", "washington, d.c.": "DC",
};

const STATE_TO_REGION = new Map<string, Region>();
for (const [region, states] of Object.entries(BY_REGION)) {
  for (const state of states) STATE_TO_REGION.set(state, region as Region);
}

const EUROPEAN = new Set([
  "united kingdom", "uk", "england", "scotland", "wales", "ireland", "france", "germany",
  "spain", "portugal", "italy", "netherlands", "belgium", "denmark", "sweden", "norway",
  "finland", "iceland", "austria", "switzerland", "poland", "czechia", "czech republic",
]);

function isCanada(country: string): boolean {
  return country === "canada" || country === "ca";
}

export function regionFor(state: string | null | undefined, country: string | null | undefined): Region {
  const c = (country ?? "").trim().toLowerCase();
  // Country is checked before state because Canadian provinces share
  // abbreviations with US states -- ON, NB and BC would otherwise be read
  // as nothing, but QC/AB would not, and a Canadian venue must never land
  // in a US region.
  if (isCanada(c)) return "Canada";
  if (EUROPEAN.has(c)) return "Europe";

  const raw = (state ?? "").trim();
  // "--" is a real placeholder in this table, written for organisations
  // that cover a whole region rather than sitting in one state.
  if (!raw || raw === "--") return "Other";

  const code = raw.length === 2 ? raw.toUpperCase() : FULL_NAMES[raw.toLowerCase()];
  if (!code) return "Other";
  return STATE_TO_REGION.get(code) ?? "Other";
}
