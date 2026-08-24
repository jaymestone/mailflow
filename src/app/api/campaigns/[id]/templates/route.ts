import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findUnresolvedTokens, resolveTemplate } from "@/lib/templates/resolve";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { step_number, days_after_previous, test_delay_minutes, subject, body } = await request.json();

  // Step 1 has no prior step to derive a subject from, so it's required.
  // Later steps can leave it blank — the send engine fills in
  // "Re: [step 1's subject]" automatically.
  if (!step_number || !body?.trim() || (step_number === 1 && !subject?.trim())) {
    return NextResponse.json(
      { error: "step_number and body are required; subject is required for step 1" },
      { status: 400 },
    );
  }

  // Sanity-check against a dummy contact so obviously broken templates
  // (unknown merge fields, malformed spintext) are rejected up front.
  const dummy = { first_name: "Test", last_name: "Contact", venue: "Test Venue", city: "Test City", state: "TS" };
  const resolvedSubject = resolveTemplate(subject ?? "", dummy);
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
      // Testing-only cadence override — overrides days_after_previous when
      // set, cleared (set to null) whenever the request omits it.
      test_delay_minutes: test_delay_minutes ?? null,
      subject: (subject ?? "").trim(),
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
