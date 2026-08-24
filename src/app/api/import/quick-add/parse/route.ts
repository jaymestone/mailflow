import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseQuickAddContacts } from "@/lib/import/quickAdd";

export const maxDuration = 60;

export async function POST(request: Request) {
  await createClient(); // confirms a session exists, same as every other authed route
  const { text } = await request.json();
  if (!text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  try {
    const contacts = await parseQuickAddContacts(text);
    return NextResponse.json({ contacts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Could not parse contacts: ${message}` }, { status: 500 });
  }
}
