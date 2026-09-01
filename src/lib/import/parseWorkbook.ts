import * as XLSX from "xlsx";
import { NON_CONTACT_SHEET_NAMES, resolveHeaderKey, type ContactKey } from "./schema";

export type ParsedContactRow = Partial<Record<ContactKey, string>>;

export type ParsedSheet = {
  sheetName: string;
  rows: ParsedContactRow[];
};

const GENERIC_SHEET_NAME_RE = /^sheet\d*$/i;

/** A plain CSV (as opposed to a real multi-tab workbook) always parses to
 * a single sheet with a generic library-assigned name like "Sheet1" — that
 * name carries no information about what the file actually is, unlike the
 * filename itself. Uploads named like "Master Presenters Aug 29, 2026 -
 * Classical.csv" are a single category per file, so the part after the
 * last " - " is what should become the list name; falling back to the
 * whole filename when that pattern isn't present. */
function deriveNameFromFilename(filename: string): string {
  const withoutExt = filename.replace(/\.(csv|xlsx?|xls)$/i, "");
  const lastDash = withoutExt.lastIndexOf(" - ");
  return (lastDash === -1 ? withoutExt : withoutExt.slice(lastDash + 3)).trim();
}

/**
 * Parses an uploaded workbook (.xlsx or .csv) into one entry per sheet that
 * looks like a contact tab (has a recognizable header row and isn't one of
 * the old system's non-contact tabs like Campaigns/Templates/Suppression).
 * `filename` is only used to name the list when a plain CSV produces a
 * single, genuinely-unnamed sheet — a real multi-tab workbook's own tab
 * names always take precedence.
 */
export function parseWorkbook(buffer: ArrayBuffer, filename?: string): ParsedSheet[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheets: ParsedSheet[] = [];
  const useFilenameAsSheetName =
    !!filename && workbook.SheetNames.length === 1 && GENERIC_SHEET_NAME_RE.test(workbook.SheetNames[0]);

  for (const rawSheetName of workbook.SheetNames) {
    const sheetName = useFilenameAsSheetName ? deriveNameFromFilename(filename!) : rawSheetName;
    if (NON_CONTACT_SHEET_NAMES.has(sheetName.trim().toLowerCase())) continue;

    const worksheet = workbook.Sheets[rawSheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });
    if (rows.length === 0) continue;

    const headerRow = rows[0];
    const keyByColumn = headerRow.map((h) => resolveHeaderKey(String(h)));

    // Skip sheets that don't have an "Email" column — not a contact tab.
    if (!keyByColumn.includes("email")) continue;

    const parsedRows: ParsedContactRow[] = [];
    for (const row of rows.slice(1)) {
      const parsed: ParsedContactRow = {};
      keyByColumn.forEach((key, i) => {
        if (!key) return;
        const value = row[i];
        if (value === undefined || value === null) return;
        const str = String(value).trim();
        if (str) parsed[key] = str;
      });
      if (Object.keys(parsed).length > 0) parsedRows.push(parsed);
    }

    sheets.push({ sheetName, rows: parsedRows });
  }

  return sheets;
}
