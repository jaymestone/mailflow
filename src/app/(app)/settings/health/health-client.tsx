"use client";

import { useEffect, useState } from "react";

type DnsResult = {
  domain: string;
  spf: { found: boolean; record?: string };
  dmarc: { found: boolean; record?: string };
};

export function DeliverabilityCheck({ domains }: { domains: string[] }) {
  const [results, setResults] = useState<Record<string, DnsResult>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (domains.length === 0) {
      setLoading(false);
      return;
    }
    Promise.all(
      domains.map((d) => fetch(`/api/health/dns?domain=${encodeURIComponent(d)}`).then((r) => r.json())),
    ).then((all: DnsResult[]) => {
      setResults(Object.fromEntries(all.map((r) => [r.domain, r])));
      setLoading(false);
    });
  }, [domains]);

  if (domains.length === 0) {
    return <p className="text-sm text-neutral-500">Connect a sending account to check its domain.</p>;
  }
  if (loading) return <p className="text-sm text-neutral-500">Checking DNS records…</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-neutral-800 bg-neutral-900 text-xs uppercase text-neutral-500">
          <tr>
            <th className="px-3 py-2">Domain</th>
            <th className="px-3 py-2">SPF</th>
            <th className="px-3 py-2">DMARC</th>
          </tr>
        </thead>
        <tbody>
          {domains.map((d) => {
            const r = results[d];
            return (
              <tr key={d} className="border-b border-neutral-900">
                <td className="px-3 py-2 text-neutral-100">{d}</td>
                <td className={`px-3 py-2 text-xs ${r?.spf.found ? "text-emerald-400" : "text-red-400"}`}>
                  {r?.spf.found ? "found" : "missing"}
                </td>
                <td className={`px-3 py-2 text-xs ${r?.dmarc.found ? "text-emerald-400" : "text-red-400"}`}>
                  {r?.dmarc.found ? "found" : "missing"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
