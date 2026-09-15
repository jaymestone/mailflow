import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAccessToken } from "@/lib/gmail/client";

// TEMPORARY diagnostic route -- checks a specific Gmail message's actual
// current labelIds against what Mailflow's own DB has recorded, to confirm
// or rule out a suspected bug (a message classified/inserted but whose
// label application silently failed and, since the existing-row check
// treats "in the DB" as "fully handled," never gets retried). Not wired
// into any UI, guarded by the same cron secret as every other cron route.
// Delete once the investigation it's for is resolved.
export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId, gmailMessageId } = await request.json();
  const admin = createAdminClient();
  const accessToken = await getAccessToken(admin, accountId);

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=minimal`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    return NextResponse.json({ error: `Gmail get message failed: ${res.status} ${await res.text()}` }, { status: 502 });
  }
  const data = await res.json();
  return NextResponse.json({ labelIds: data.labelIds ?? [] });
}
