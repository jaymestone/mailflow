/** The roster the booking sheet tracks, as the summariser may name it.
 *
 * Kavita Shah is deliberately absent: Jayme no longer represents her
 * (2026-10-08). "Sam Reider & the Human Hands" is "Sam Reider". */
export const SHEET_ROSTER = [
  "The Little Mercies",
  "Rakish",
  "Amanda Pascali",
  "Sam Reider",
  "Jorge Glem & Sam Reider",
  "Lily Henley",
  "Samir Langus",
  "Charlie & The Tropicales",
  "Summer Camargo",
] as const;

export type RosterArtist = (typeof SHEET_ROSTER)[number];

/** Each artist's workbook tab in [MASTER] Tour Dates, by year. */
export function workbookTab(artist: string, year: number | string): string {
  return `${artist.replace(/^The\s+/, "")} ${year} Workbook`;
}

export const MASTER_SPREADSHEET_ID = "1xcDRCQt0jsh2zq9UCO2ujltM8kVaFZ5rBJFQ3oty7Sc";
