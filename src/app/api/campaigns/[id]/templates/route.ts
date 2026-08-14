import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findUnresolvedTokens, resolveTemplate } from "@/lib/templates/resolve";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { step_number, days_after_previous, subject, body } = await request.json();

  if (!step_number || !subject?.trim() || !body?.trim()) {
    return NextResponse.json({ error: "step_number, subject, body required" }, { status: 400 });
  }

  // Sanity-check against a dummy contact so obviously broken templates
  // (unknown merge fields, malformed spintext) are rejected up front.
  const dummy = { first_name: "Test", last_name: "Contact", venue: "Test Venue", city: "Test City", state: "TS" };
  const resolvedSubject = resolveTemplate(subject, dummy);
  const resolvedBody = resolveTemplate(body, dummy);
  const unresolved = [...findUnresolvedTokens(resolvedSubject), ...findUnresolvedTokens(resolvedBody)];
  if (unresolved.length > 0) {
    return NextResponse.json(
      { error: `Unresolved tokens in template: ${unresolved.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.from("campaign_templates").upsert(
    {
      campaign_id: id,
      step_number,
      days_after_previous: days_after_previous ?? 0,
      subject: subject.trim(),
      body: body.trim(),
    },
    { onConflict: "campaign_id,step_number" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { step_number } = await request.json();

  const supabase = await createClient();
  const { error } = await supabase
    .from("campaign_templates")
    .delete()
    .eq("campaign_id", id)
    .eq("step_number", step_number);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
