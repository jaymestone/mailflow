import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for background jobs (cron ticks, webhooks) that have
 * no user session to read RLS-gated data through. Server-only — never
 * import this from a client component.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
