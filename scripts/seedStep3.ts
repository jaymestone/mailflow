// Seeds step 3 of US Venues Roster Announce: the default body plus the
// three audience variants, using the copy Jayme approved on 2026-09-23.
//
// Idempotent -- upserts on (campaign_id, step_number, variant), so running
// it again after he edits the text in the app would OVERWRITE his edits.
// Once it has run, the app is the place to change this copy, not here.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const SIGNATURE = `

Good things,

Jayme Stone
303.495.0989
[jaymestone.com](https://www.jaymestone.com/agency)
instigator / integrator`;

// Steps 2 and 3 thread as replies under step 1, where the subject is
// inherited from the original message -- step 2 already ships with an
// empty subject for exactly this reason.
const SUBJECT = "";

const VARIANTS: { variant: string; body: string }[] = [
  {
    // Only ever reached by a contact with 1-3 genuinely clicked artists,
    // so {{Clicked Artists}} always has something to say. If it somehow
    // doesn't, the token stays unresolved and the send engine skips the
    // contact rather than sending a sentence with a hole in it.
    variant: "clicked_focused",
    body: `Hi {{First Name}},

Following up on the new roster — I think {{Clicked Artists}} could be especially good for your audience.

Happy to send availability, fees or videos. And if you let me know what you're after next season, I can suggest a few others.${SIGNATURE}`,
  },
  {
    variant: "clicked_broad",
    body: `Hi {{First Name}},

Wanted to follow up on the roster once more.

Happy to send availability, fees or videos for any of the artists. And if you let me know what you're after for next season, I'm glad to suggest a few that might be a good fit.${SIGNATURE}`,
  },
  {
    // The referral ask in the last line is the highest-yield question to
    // put to someone silent through two emails: the likeliest reason for
    // silence is that they are not the booker, and those replies feed the
    // replacement-contact research queue.
    variant: "no_click",
    body: `Hi {{First Name}},

Last one from me, I promise.

If the timing's ever better, I'm glad to send availability or fees for any of the artists — or just be in touch when someone's routing your way.

And if I've got the wrong person at {{Venue}}, I'd be grateful if you pointed me toward whoever books.${SIGNATURE}`,
  },
];

async function main() {
  const dryRun = process.argv.includes("--dry");
  const { data: camp, error } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("name", "US Venues Roster Announce")
    .single();
  if (error) throw new Error(error.message);
  const campaignId = (camp as { id: string }).id;

  const { data: existing } = await supabase
    .from("campaign_templates")
    .select("variant")
    .eq("campaign_id", campaignId)
    .eq("step_number", 3);
  if ((existing ?? []).length > 0) {
    console.log(`Step 3 already has ${(existing ?? []).length} row(s): ${(existing ?? []).map((r: { variant: string }) => r.variant).join(", ")}`);
    console.log("Refusing to overwrite -- edit the copy in the app instead.");
    return;
  }

  // The 'default' row is the one send_engine_who_is_due joins, and its
  // days_after_previous is what sets the whole step's cadence. It doubles
  // as the fallback if a variant is ever missing, so it carries the
  // no_click text -- the only one of the three that is safe to send to
  // anybody, since it asserts nothing about what they did.
  const rows = [
    {
      campaign_id: campaignId,
      step_number: 3,
      variant: "default",
      days_after_previous: 10,
      subject: SUBJECT,
      body: VARIANTS.find((v) => v.variant === "no_click")!.body,
    },
    ...VARIANTS.map((v) => ({
      campaign_id: campaignId,
      step_number: 3,
      variant: v.variant,
      days_after_previous: 10,
      subject: SUBJECT,
      body: v.body,
    })),
  ];

  if (dryRun) {
    for (const r of rows) console.log(`\n=== ${r.variant} (step ${r.step_number}, +${r.days_after_previous}d) ===\n${r.body}`);
    console.log(`\nDRY RUN: would insert ${rows.length} rows`);
    return;
  }

  const { error: insErr } = await supabase.from("campaign_templates").insert(rows);
  if (insErr) throw new Error(insErr.message);
  console.log(`Inserted ${rows.length} step-3 rows: ${rows.map((r) => r.variant).join(", ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  });
