"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleSignOut}
      className="w-full rounded-md border border-neutral-800 px-2 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-50"
    >
      Sign out
    </button>
  );
}
