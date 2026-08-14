"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RestoreButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function restore() {
    if (!confirm("Restore this address? It will become eligible for sending again.")) return;
    setBusy(true);
    await fetch("/api/suppression/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <button onClick={restore} disabled={busy} className="text-xs text-neutral-400 hover:text-neutral-100 disabled:opacity-50">
      Restore
    </button>
  );
}
