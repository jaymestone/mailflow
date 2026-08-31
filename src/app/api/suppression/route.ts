import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const VALID_REASONS = ["bounce", "opt_out", "manual", "departed"];
const EMAIL_RE = /[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/g;

// Accepts either a clean list of emails or a blob of pasted text/CSV
// content — anything email-shaped is extracted, everything else (names,
// other columns) is ignored, so a raw CSV export can be pasted directly
// without needing to isolate the Email column first.
export async function POST(request: Request) {
  const { text, reason, notes } = await request.json();
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (!VALID_REASONS.includes(reason)) return NextResponse.json({ error: "invalid reason" }, { status: 400 });

  const found = text.match(EMAIL_RE) ?? [];
  const emails = [...new Set(found.map((e: string) => e.toLowerCase()))];
  if (emails.length === 0) return NextResponse.json({ error: "no email addresses found" }, { status: 400 });

  const supabase = await createClient();
  const { data: existing } = await supabase.from("suppression").select("email");
  const alreadySuppressed = new Set((existing ?? []).map((s) => s.email.toLowerCase()));
  const toInsert = emails.filter((e) => !alreadySuppressed.has(e));

  if (toInsert.length > 0) {
    const rows = toInsert.map((email) => ({ email, reason, notes: notes?.trim() || null }));
    const { error } = await supabase.from("suppression").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    found: emails.length,
    added: toInsert.length,
    alreadySuppressed: emails.length - toInsert.length,
  });
}
