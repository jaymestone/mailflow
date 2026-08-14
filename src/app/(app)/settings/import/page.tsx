"use client";

import { useRef, useState } from "react";

type ImportResult = {
  jobId: string;
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
  errors: { sheet: string; row: number; reason: string }[];
  sheets: { name: string; rows: number }[];
};

export default function ImportPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setStatus("uploading");
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Import failed");
        setStatus("error");
        return;
      }
      setResult(data);
      setStatus("done");
    } catch {
      setError("Import failed — network error");
      setStatus("error");
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-balance text-2xl font-semibold">Import contacts</h1>
      <p className="mt-2 text-pretty text-sm text-neutral-400">
        Upload a CSV or XLSX. Each sheet tab is matched to a list by name (creating a new list if
        none matches), and rows are read against the 13-column schema: First Name, Last Name,
        Email, Venue, Venue Type, City, State, Country, Notes, Source, Mobile, Phone, Website.
        Duplicate emails (already in the database or repeated in the file) are skipped.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          required
          className="text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-sm file:text-neutral-100 hover:file:bg-neutral-700"
        />
        <button
          type="submit"
          disabled={status === "uploading"}
          className="rounded-lg bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
        >
          {status === "uploading" ? "Importing…" : "Import"}
        </button>
      </form>

      {error && <p className="mt-4 text-pretty text-sm text-red-400">{error}</p>}

      {result && (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="grid grid-cols-4 gap-4 text-center">
            <Stat label="Total rows" value={result.total} />
            <Stat label="Inserted" value={result.inserted} tone="text-emerald-400" />
            <Stat label="Skipped (dupes)" value={result.skipped} tone="text-neutral-400" />
            <Stat label="Failed" value={result.failed} tone="text-red-400" />
          </div>

          <div className="mt-4 text-xs text-neutral-500">
            Sheets: {result.sheets.map((s) => `${s.name} (${s.rows})`).join(", ")}
          </div>

          {result.errors.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-medium text-neutral-400">
                First {result.errors.length} issues
              </div>
              <ul className="mt-1 max-h-48 overflow-y-auto text-xs text-neutral-500">
                {result.errors.map((e, i) => (
                  <li key={i}>
                    {e.sheet} row {e.row}: {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className={`text-2xl font-semibold ${tone ?? "text-neutral-50"}`}>{value}</div>
      <div className="text-pretty text-xs text-neutral-500">{label}</div>
    </div>
  );
}
