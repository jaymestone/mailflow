"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/venues", label: "Venues" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/inbox", label: "Inbox" },
  { href: "/bounces", label: "Bounces" },
  { href: "/settings/lists", label: "Lists" },
  { href: "/settings/accounts", label: "Accounts" },
  { href: "/settings/import", label: "Import" },
  { href: "/settings/geocoding", label: "Geocoding" },
  { href: "/settings/health", label: "Health" },
];

export function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-7">
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`border-b-2 pb-3 text-sm font-medium no-underline ${
              isActive ? "border-accent text-accent" : "border-transparent text-muted-2 hover:text-ink"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
