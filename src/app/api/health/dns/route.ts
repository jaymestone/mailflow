import { NextResponse } from "next/server";
import { resolveTxt } from "node:dns/promises";

async function checkSpf(domain: string): Promise<{ found: boolean; record?: string }> {
  try {
    const records = await resolveTxt(domain);
    const spf = records.map((r) => r.join("")).find((r) => r.startsWith("v=spf1"));
    return spf ? { found: true, record: spf } : { found: false };
  } catch {
    return { found: false };
  }
}

async function checkDmarc(domain: string): Promise<{ found: boolean; record?: string }> {
  try {
    const records = await resolveTxt(`_dmarc.${domain}`);
    const dmarc = records.map((r) => r.join("")).find((r) => r.startsWith("v=DMARC1"));
    return dmarc ? { found: true, record: dmarc } : { found: false };
  } catch {
    return { found: false };
  }
}

export async function GET(request: Request) {
  const domain = new URL(request.url).searchParams.get("domain");
  if (!domain) return NextResponse.json({ error: "domain query param required" }, { status: 400 });

  const [spf, dmarc] = await Promise.all([checkSpf(domain), checkDmarc(domain)]);
  return NextResponse.json({ domain, spf, dmarc });
}
