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
    return <p className="text-sm text-muted-3">Connect a sending account to check its domain.</p>;
  }
  if (loading) return <p className="text-sm text-muted-3">Checking DNS records…</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-hairline-strong text-[10px] tracking-wide text-faint uppercase">
          <tr>
            <th className="py-2 pr-3">Domain</th>
            <th className="py-2 pr-3">SPF</th>
            <th className="py-2 pr-3">DMARC</th>
          </tr>
        </thead>
        <tbody>
          {domains.map((d) => {
            const r = results[d];
            return (
              <tr key={d} className="border-b border-hairline-soft">
                <td className="py-2.5 pr-3 text-ink">{d}</td>
                <td className={`py-2.5 pr-3 text-xs ${r?.spf.found ? "text-success" : "text-error"}`}>
                  {r?.spf.found ? "found" : "missing"}
                </td>
                <td className={`py-2.5 pr-3 text-xs ${r?.dmarc.found ? "text-success" : "text-error"}`}>
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
