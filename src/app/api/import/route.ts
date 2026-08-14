import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseWorkbook, type ParsedContactRow } from "@/lib/import/parseWorkbook";
import type { ContactKey } from "@/lib/import/schema";

export const maxDuration = 60;

const BATCH_SIZE = 500;
const MAX_ERRORS_TRACKED = 50;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

type StagedContact = Record<ContactKey, string | null> & { list_id: string };

export async function POST(request: Request) {
  const supabase = await createClient();

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  const buffer = await file.arrayBuffer();
  let sheets;
  try {
    sheets = parseWorkbook(buffer);
  } catch {
    return NextResponse.json({ error: "Could not parse file as CSV/XLSX" }, { status: 400 });
  }

  if (sheets.length === 0) {
    return NextResponse.json(
      { error: "No recognizable contact sheets found (need an Email column)" },
      { status: 400 },
    );
  }

  const totalRows = sheets.reduce((sum, s) => sum + s.rows.length, 0);

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({ status: "running", filename: file.name, total: totalRows, started_at: new Date().toISOString() })
    .select("id")
    .single();
  if (jobError || !job) {
    return NextResponse.json({ error: "Could not create import job" }, { status: 500 });
  }

  const { data: existingLists } = await supabase.from("lists").select("id, name");
  const listIdByName = new Map((existingLists ?? []).map((l) => [l.name.trim().toLowerCase(), l.id]));

  const { data: existingContacts } = await supabase.from("contacts").select("email");
  const seenEmails = new Set((existingContacts ?? []).map((c) => c.email.toLowerCase()));

  const errors: { sheet: string; row: number; reason: string }[] = [];
  const staged: StagedContact[] = [];
  let skipped = 0;
  let failed = 0;

  for (const sheet of sheets) {
    let listId = listIdByName.get(sheet.sheetName.trim().toLowerCase());
    if (!listId) {
      const { data: newList, error: listError } = await supabase
        .from("lists")
        .insert({ name: sheet.sheetName.trim() })
        .select("id")
        .single();
      if (listError || !newList) {
        errors.push({ sheet: sheet.sheetName, row: 0, reason: `Could not create list: ${listError?.message}` });
        failed += sheet.rows.length;
        continue;
      }
      listId = newList.id;
      listIdByName.set(sheet.sheetName.trim().toLowerCase(), listId);
    }

    sheet.rows.forEach((row: ParsedContactRow, i: number) => {
      const email = row.email?.trim();
      if (!email || !isValidEmail(email)) {
        failed++;
        if (errors.length < MAX_ERRORS_TRACKED) {
          errors.push({ sheet: sheet.sheetName, row: i + 2, reason: "Missing or invalid email" });
        }
        return;
      }

      const lowerEmail = email.toLowerCase();
      if (seenEmails.has(lowerEmail)) {
        skipped++;
        return;
      }
      seenEmails.add(lowerEmail);

      staged.push({
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        email,
        venue: row.venue ?? null,
        venue_type: row.venue_type ?? null,
        city: row.city ?? null,
        state: row.state ?? null,
        country: row.country ?? null,
        notes: row.notes ?? null,
        source: row.source ?? null,
        mobile: row.mobile ?? null,
        phone: row.phone ?? null,
        website: row.website ?? null,
        list_id: listId!,
      });
    });
  }

  let inserted = 0;
  for (let i = 0; i < staged.length; i += BATCH_SIZE) {
    const batch = staged.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase.from("contacts").insert(batch).select("id");
    if (error) {
      failed += batch.length;
      if (errors.length < MAX_ERRORS_TRACKED) {
        errors.push({ sheet: "(batch insert)", row: i, reason: error.message });
      }
      continue;
    }
    inserted += data?.length ?? 0;
  }

  const processed = inserted + skipped + failed;

  await supabase
    .from("import_jobs")
    .update({
      status: "completed",
      processed,
      inserted,
      skipped,
      failed,
      errors,
      finished_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return NextResponse.json({
    jobId: job.id,
    total: totalRows,
    inserted,
    skipped,
    failed,
    errors,
    sheets: sheets.map((s) => ({ name: s.sheetName, rows: s.rows.length })),
  });
}
