"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setError(error.message);
      return;
    }

    setStatus("sent");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-[400px]">
        <div className="mb-2 font-display text-[32px] italic text-ink">Mailflow</div>
        <h1 className="text-balance font-display text-[26px] font-medium leading-tight text-ink">
          Sign in to your workspace
        </h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-muted">
          We&apos;ll email a one-time link. No password to remember.
        </p>

        {status === "sent" ? (
          <p className="mt-7 text-pretty text-sm text-success">Check {email} for a sign-in link.</p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-7">
            <label className="mb-1.5 block text-[11px] tracking-wide text-muted-2 uppercase">
              Email address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@youragency.com"
              className="mb-6 w-full border-0 border-b border-rule bg-transparent px-0.5 py-2.5 text-[15px] text-ink outline-none placeholder:text-faint-3"
            />
            <button
              type="submit"
              disabled={status === "sending"}
              className="w-full rounded-[2px] bg-ink px-3 py-3 text-sm font-semibold tracking-wide text-surface disabled:opacity-50"
            >
              {status === "sending" ? "Sending…" : "Send sign-in link"}
            </button>
            {error && <p className="mt-3 text-pretty text-sm text-error">{error}</p>}
          </form>
        )}
        <p className="mt-6 text-xs text-faint-3">Venue outreach, done with care.</p>
      </div>
    </div>
  );
}
