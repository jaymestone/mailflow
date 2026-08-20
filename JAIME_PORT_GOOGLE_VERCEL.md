# Porting Mailflow off Spencer's infrastructure

Right now Mailflow runs on a mix of accounts: your Supabase project (already
yours), but Spencer's Vercel account and Spencer's Google Cloud OAuth client.
This doc is everything needed to move the last two pieces (Vercel + Google
OAuth) fully onto your own accounts, so Spencer's infrastructure can be
decommissioned.

Nothing here touches Supabase, that part already lives with you.

---

## 0. Get the code

The repo is currently `github.com/spencerhandley/mailflow`. Pick one:

- **Fork it** to your own GitHub account (fastest, no action needed from
  Spencer beyond the repo being visible to you), or
- **Ask Spencer to transfer ownership** of the repo to your GitHub account
  (cleaner long-term, preserves history under your name).

Either way, you'll deploy from your own copy, not his.

`.env.local` (the secrets file) is gitignored, so cloning/forking the repo
does **not** hand you any of Spencer's actual credentials. You're generating
all of the values below fresh.

---

## 1. Google Cloud: create your own OAuth client

This app doesn't use Google for user sign-in (that's Supabase magic-link
email). Google OAuth here is only used to connect the Gmail *sending*
addresses (the ones that actually send outreach email and read replies), via
Settings → Accounts in the app.

1. In [Google Cloud Console](https://console.cloud.google.com), create a new
   project (or use an existing one of yours) — e.g. "Mailflow".
2. Enable the **Gmail API** for that project (APIs & Services → Library →
   search "Gmail API" → Enable).
3. Configure the **OAuth consent screen** (APIs & Services → OAuth consent
   screen):
   - User type: External.
   - Scopes: add these four —
     - `openid`
     - `email`
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.modify`
   - Add every Gmail address you plan to connect as a sending account as a
     **test user**, or as an owner/editor on the project.
   - **Important gotcha:** if you leave the app in "Testing" publishing
     status, Google expires the refresh tokens after 7 days and the app
     will silently stop being able to send/read mail until someone
     reconnects it. Set publishing status to **"In production"** instead.
     You do not need to complete Google's verification review for this —
     it just means anyone connecting will see an "unverified app" click-
     through warning, which is fine since it's only you/your team
     authorizing your own accounts.
4. Create credentials → **OAuth client ID** → Application type: **Web
   application**.
   - Authorized redirect URI: `https://<your-production-domain>/api/oauth/google/callback`
   - You'll only know the final domain once you've deployed to Vercel (step
     2 below gives you a `*.vercel.app` URL, or your own custom domain if you
     set one up). Come back and add the exact redirect URI once you have it,
     you can add/edit it any time from this same screen.
5. Save the **Client ID** and **Client secret**. These become
   `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in step 3.

---

## 2. Vercel: deploy under your own account

1. Create a new project in your own Vercel account, importing the GitHub
   repo from step 0.
2. Framework preset should auto-detect as Next.js. No build config changes
   needed.
3. Don't deploy yet, add the environment variables first (next step) so the
   first build isn't broken.

---

## 3. Environment variables (set these in the Vercel project)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | From your existing Supabase project → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page, "anon public" key |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page, "service_role" key (keep secret) |
| `GOOGLE_OAUTH_CLIENT_ID` | From step 1 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | From step 1 |
| `ANTHROPIC_API_KEY` | From your own Anthropic Console account (used for reply classification) |
| `CRON_SECRET` | Any random string you generate yourself, e.g. `openssl rand -hex 32`. This is a shared secret between Vercel and Supabase, see step 5. |

Deploy once these are set. Note the resulting production URL (either the
`*.vercel.app` domain Vercel gives you, or a custom domain if you attach
one).

---

## 4. Go back and finish the Google OAuth client

Now that you have a real production URL, go back to the OAuth client from
step 1 and set the redirect URI to:

```
https://<your-actual-domain>/api/oauth/google/callback
```

It must match exactly (including https and no trailing slash).

---

## 5. Point Supabase's cron jobs at the new URL

Your Supabase project already has three scheduled jobs (`pg_cron`) that ping
the app on a timer to send queued emails, poll for replies, and geocode
venues. They were set up pointing at Spencer's old Vercel URL
(`mailflow-flame.vercel.app`), so they need to be re-pointed at your new one.

Run this in the Supabase SQL editor, using your **new** production domain
and the **same** `CRON_SECRET` value you put in Vercel in step 3:

```sql
-- Remove the old jobs
select cron.unschedule('geocode-tick');
select cron.unschedule('send-engine-tick');
select cron.unschedule('reply-poll-tick');

-- Recreate pointing at your new deployment
select cron.schedule(
  'geocode-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<your-actual-domain>/api/cron/geocode',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<YOUR_CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'send-engine-tick',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://<your-actual-domain>/api/cron/send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<YOUR_CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'reply-poll-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<your-actual-domain>/api/cron/reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<YOUR_CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);

-- Sanity check
select * from cron.job;
```

---

## 6. Reconnect the Gmail sending accounts

Google refresh tokens are tied to the OAuth client that issued them. Since
you created a brand-new client in step 1, the sending accounts that were
previously connected under Spencer's client need to be reconnected under
yours.

In the app: **Settings → Accounts**, disconnect and reconnect each Gmail
sending address (including the reply/catch-all inbox), going through the
Google consent screen again for each one.

---

## 7. Test before trusting it

- Send a test campaign to your own address and confirm it arrives.
- Reply to it from that same address and confirm the reply gets picked up
  and classified within ~5 minutes (the `reply-poll-tick` cadence).
- Check Settings → Health in the app, everything should read green with
  recent cron heartbeats.

---

## What to send back to Spencer

Once you've completed the above, the only things Spencer needs from you are:

1. **Confirmation the fork/transfer is done** (step 0), so he knows he can
   remove your access from his original repo if he wants.
2. **The new production URL**, just so he has it for reference.

Once you confirm everything above is working end to end, Spencer can safely
delete his old Vercel project and the old Google Cloud OAuth client.
