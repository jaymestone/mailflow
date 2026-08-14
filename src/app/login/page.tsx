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
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-8">
        <h1 className="text-balance text-xl font-semibold text-neutral-50">
          Sign in to MailFlow
        </h1>
        <p className="mt-1 text-pretty text-sm text-neutral-400">
          We&apos;ll email you a one-time sign-in link. No password needed.
        </p>

        {status === "sent" ? (
          <p className="mt-6 text-pretty text-sm text-emerald-400">
            Check {email} for a sign-in link.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourdomain.com"
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
            />
            <button
              type="submit"
              disabled={status === "sending"}
              className="rounded-lg bg-neutral-50 px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
            >
              {status === "sending" ? "Sending…" : "Send sign-in link"}
            </button>
            {error && <p className="text-pretty text-sm text-red-400">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
