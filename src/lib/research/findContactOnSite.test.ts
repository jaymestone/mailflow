import { describe, it, expect } from "vitest";
import {
  extractEmails,
  rankCandidates,
  rootDomain,
  pathsFromSitemap,
  findContactOnSite,
  type Fetcher,
} from "./findContactOnSite";

describe("rootDomain", () => {
  it("treats subdomains as the same organisation", () => {
    expect(rootDomain("tickets.venue.org")).toBe("venue.org");
    expect(rootDomain("www.venue.org")).toBe("venue.org");
  });

  it("handles two-part country suffixes", () => {
    expect(rootDomain("box.mwldan.co.uk")).toBe("mwldan.co.uk");
    expect(rootDomain("mwldan.co.uk")).toBe("mwldan.co.uk");
  });
});

describe("extractEmails", () => {
  it("reads an address hidden behind a mailto link", () => {
    // The common case on arts sites: the rendered page shows a button, and
    // the address only exists in the href.
    const html = '<a class="btn" href="mailto:booking@venue.org">Get in touch</a>';
    expect(extractEmails(html, "venue.org", "/contact")).toEqual([
      { email: "booking@venue.org", kind: "booking", foundOn: "/contact" },
    ]);
  });

  it("rejects addresses belonging to someone other than the venue", () => {
    // A web designer's or ticketing partner's footer address is not the
    // venue's booking contact.
    const html = "info@venue.org and hello@somedesignagency.com";
    expect(extractEmails(html, "venue.org", "/contact").map((c) => c.email)).toEqual(["info@venue.org"]);
  });

  it("rejects no-reply and infrastructure addresses", () => {
    const html = "no-reply@venue.org webmaster@venue.org privacy@venue.org booking@venue.org";
    expect(extractEmails(html, "venue.org", "/contact").map((c) => c.email)).toEqual(["booking@venue.org"]);
  });

  it("rejects asset filenames that match the address pattern", () => {
    const html = '<img src="logo@2x.png"> <img src="hero@venue.org.jpg"> real@venue.org';
    expect(extractEmails(html, "venue.org", "/").map((c) => c.email)).toEqual(["real@venue.org"]);
  });

  it("accepts an address on a subdomain of the venue", () => {
    const html = "tickets@boxoffice.venue.org";
    expect(extractEmails(html, "venue.org", "/contact")).toHaveLength(1);
  });

  it("deduplicates the same address appearing twice on a page", () => {
    const html = '<a href="mailto:info@venue.org">info@venue.org</a>';
    expect(extractEmails(html, "venue.org", "/contact")).toHaveLength(1);
  });

  it("classifies by what the local part says it does", () => {
    const html = "booking@v.org jane.smith@v.org info@v.org talentbuyer@v.org";
    const byEmail = Object.fromEntries(extractEmails(html, "v.org", "/x").map((c) => [c.email, c.kind]));
    expect(byEmail["booking@v.org"]).toBe("booking");
    expect(byEmail["talentbuyer@v.org"]).toBe("booking");
    expect(byEmail["jane.smith@v.org"]).toBe("person");
    expect(byEmail["info@v.org"]).toBe("generic");
  });
});

describe("rankCandidates", () => {
  it("puts a booking address ahead of a person ahead of a front desk", () => {
    const ranked = rankCandidates([
      { email: "info@v.org", kind: "generic", foundOn: "/c" },
      { email: "jane@v.org", kind: "person", foundOn: "/c" },
      { email: "booking@v.org", kind: "booking", foundOn: "/c" },
    ]);
    expect(ranked.map((r) => r.email)).toEqual(["booking@v.org", "jane@v.org", "info@v.org"]);
  });
});

describe("pathsFromSitemap", () => {
  it("picks out contact-ish paths and ignores the rest", () => {
    const xml = `<urlset>
      <url><loc>https://v.org/shows/2027</loc></url>
      <url><loc>https://v.org/who-we-are</loc></url>
      <url><loc>https://v.org/contact-the-team</loc></url>
    </urlset>`;
    expect(pathsFromSitemap(xml)).toEqual(["/who-we-are", "/contact-the-team"]);
  });

  it("survives malformed entries", () => {
    expect(pathsFromSitemap("<loc>not a url</loc><loc>https://v.org/contact</loc>")).toEqual(["/contact"]);
  });
});

/** Records which URLs were asked for, so the fetch budget can be asserted. */
function mockFetcher(pages: Record<string, string>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const body = pages[url];
    if (body === undefined) return { ok: false, status: 404, text: "" };
    return { ok: true, status: 200, text: body };
  };
  return Object.assign(f, { calls });
}

describe("findContactOnSite", () => {
  it("finds the booking address and stops paying for more pages", async () => {
    const fetcher = mockFetcher({
      "https://v.org/contact": '<a href="mailto:booking@v.org">book</a>',
      "https://v.org/staff": "should never be fetched",
    });

    const result = await findContactOnSite("v.org", fetcher);

    expect(result.found).toBe(true);
    if (result.found) expect(result.candidates[0].email).toBe("booking@v.org");
    expect(fetcher.calls).not.toContain("https://v.org/staff");
  });

  it("uses the sitemap to reach a site with an unusual path", async () => {
    const fetcher = mockFetcher({
      "https://v.org/sitemap.xml": "<urlset><url><loc>https://v.org/who-we-are</loc></url></urlset>",
      "https://v.org/who-we-are": "programming@v.org",
    });

    const result = await findContactOnSite("v.org", fetcher);

    expect(result.found).toBe(true);
    if (result.found) expect(result.candidates[0].email).toBe("programming@v.org");
  });

  it("reports unreachable rather than throwing", async () => {
    const result = await findContactOnSite("v.org", async () => {
      throw new Error("ENOTFOUND");
    });

    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe("site unreachable");
  });

  it("reports honestly when pages load but carry no address", async () => {
    const fetcher = mockFetcher({ "https://v.org/contact": "<p>Use the form below.</p>" });

    const result = await findContactOnSite("v.org", fetcher);

    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe("no address on any page tried");
  });

  it("never exceeds the page budget", async () => {
    // Every path 404s, so it will try the whole list.
    const fetcher = mockFetcher({});
    await findContactOnSite("v.org", fetcher);
    expect(fetcher.calls.length).toBeLessThanOrEqual(6);
  });

  it("normalises a host given with a scheme or www", async () => {
    const fetcher = mockFetcher({ "https://v.org/contact": "booking@v.org" });
    const result = await findContactOnSite("https://www.v.org/", fetcher);
    expect(result.host).toBe("v.org");
    expect(result.found).toBe(true);
  });

  it("collects several candidates across pages when no booking address exists", async () => {
    const fetcher = mockFetcher({
      "https://v.org/contact": "info@v.org",
      "https://v.org/contact-us": "jane.doe@v.org",
    });

    const result = await findContactOnSite("v.org", fetcher);

    expect(result.found).toBe(true);
    if (result.found) expect(result.candidates.map((c) => c.email)).toEqual(["jane.doe@v.org", "info@v.org"]);
  });
});

describe("wrong-desk addresses", () => {
  it("does not present admissions or HR as a booking contact", () => {
    // All three came back from the real 198-site run ranked as though they
    // were individuals worth pitching.
    const html = "admissions@eku.edu staffsenate@du.edu alumni@college.edu";
    const kinds = extractEmails(html, "eku.edu", "/contact").map((c) => c.kind);
    expect(kinds.every((k) => k === "wrong-desk")).toBe(true);
  });

  it("ranks a wrong-desk address last, behind even a front desk", () => {
    const ranked = rankCandidates([
      { email: "admissions@v.edu", kind: "wrong-desk", foundOn: "/c" },
      { email: "info@v.edu", kind: "generic", foundOn: "/c" },
    ]);
    expect(ranked.map((r) => r.email)).toEqual(["info@v.edu", "admissions@v.edu"]);
  });

  it("still recognises a real booking address at the same institution", () => {
    // Deliberately not boxoffice@ — that is ticketing, a different
    // department, and ranks below even a front desk.
    const html = "admissions@v.edu programming@v.edu boxoffice@v.edu";
    const byEmail = Object.fromEntries(extractEmails(html, "v.edu", "/c").map((c) => [c.email, c.kind]));
    expect(byEmail["programming@v.edu"]).toBe("booking");
    expect(byEmail["boxoffice@v.edu"]).toBe("boxoffice");
    expect(byEmail["admissions@v.edu"]).toBe("wrong-desk");
  });
});

describe("box office is not programming", () => {
  it("classifies ticketing addresses as boxoffice, not booking", () => {
    const html = "boxoffice@v.org tickets@v.org patronservices@v.org";
    const kinds = extractEmails(html, "v.org", "/contact").map((c) => c.kind);
    expect(kinds).toEqual(["boxoffice", "boxoffice", "boxoffice"]);
  });

  it("ranks the box office BELOW a front desk", () => {
    // Jayme: the box office is "a totally different department than
    // programming" — fine as a last resort, but info@ gets routed to
    // whoever should actually read it.
    const ranked = rankCandidates([
      { email: "boxoffice@v.org", kind: "boxoffice", foundOn: "/c" },
      { email: "info@v.org", kind: "generic", foundOn: "/c" },
    ]);
    expect(ranked.map((r) => r.email)).toEqual(["info@v.org", "boxoffice@v.org"]);
  });

  it("still prefers a real booking address over both", () => {
    const ranked = rankCandidates([
      { email: "boxoffice@v.org", kind: "boxoffice", foundOn: "/c" },
      { email: "info@v.org", kind: "generic", foundOn: "/c" },
      { email: "programming@v.org", kind: "booking", foundOn: "/c" },
    ]);
    expect(ranked[0].email).toBe("programming@v.org");
  });

  it("keeps searching later pages after finding only a box office address", async () => {
    // The bug this caused: /staff was never fetched, so a venue whose
    // programmer is listed there came back as its ticketing desk.
    const fetcher = mockFetcher({
      "https://v.org/contact": "boxoffice@v.org",
      "https://v.org/staff": "programming@v.org",
    });

    const result = await findContactOnSite("v.org", fetcher);

    expect(fetcher.calls).toContain("https://v.org/staff");
    expect(result.found).toBe(true);
    if (result.found) expect(result.candidates[0].email).toBe("programming@v.org");
  });
});

describe("real-run failures, found over 106 outlet domains", () => {
  it("rejects naming-convention placeholders printed on staff pages", () => {
    // americana-uk.com and latimes.com both publish these to show the house
    // format. They are instructions, not addresses.
    const html = "firstname.lastname@outlet.com firstname.surname@outlet.com real.person@outlet.com";
    const got = extractEmails(html, "outlet.com", "/staff").map((c) => c.email);
    expect(got).toEqual(["real.person@outlet.com"]);
  });

  it("treats advertising and business desks as wrong-desk, not contacts", () => {
    // The raw run offered ads@pitchfork.com and bizdev@nydailynews.com as
    // replacements for departed music writers.
    const html = "ads@v.org sales@v.org bizdev@v.org advertising@v.org sponsorship@v.org";
    const kinds = extractEmails(html, "v.org", "/contact").map((c) => c.kind);
    expect(kinds.every((k) => k === "wrong-desk")).toBe(true);
  });

  it("treats a reader-complaints or PSA line as wrong-desk", () => {
    const html = "readers.representative@v.org psa@v.org feedback@v.org";
    const kinds = extractEmails(html, "v.org", "/contact").map((c) => c.kind);
    expect(kinds.every((k) => k === "wrong-desk")).toBe(true);
  });

  it("still keeps a genuine named person whose name resembles nothing", () => {
    const html = "malte.wienker@v.de";
    expect(extractEmails(html, "v.de", "/about/staff")[0].kind).toBe("person");
  });
});
