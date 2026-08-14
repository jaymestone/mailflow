import * as XLSX from "xlsx";
import { NON_CONTACT_SHEET_NAMES, resolveHeaderKey, type ContactKey } from "./schema";

export type ParsedContactRow = Partial<Record<ContactKey, string>>;

export type ParsedSheet = {
  sheetName: string;
  rows: ParsedContactRow[];
};

/**
 * Parses an uploaded workbook (.xlsx or .csv) into one entry per sheet that
 * looks like a contact tab (has a recognizable header row and isn't one of
 * the old system's non-contact tabs like Campaigns/Templates/Suppression).
 */
export function parseWorkbook(buffer: ArrayBuffer): ParsedSheet[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheets: ParsedSheet[] = [];

  for (const sheetName of workbook.SheetNames) {
    if (NON_CONTACT_SHEET_NAMES.has(sheetName.trim().toLowerCase())) continue;

    const worksheet = workbook.Sheets[sheetName];
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
