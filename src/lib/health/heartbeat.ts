import type { SupabaseClient } from "@supabase/supabase-js";

export async function recordHeartbeat(supabase: SupabaseClient, jobName: string, result: unknown) {
  await supabase
    .from("cron_health")
    .upsert(
      { job_name: jobName, last_run_at: new Date().toISOString(), last_result: result },
      { onConflict: "job_name" },
    );
}
