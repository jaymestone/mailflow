import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

const NAV_ITEMS = [
  { href: "/venues", label: "Venues" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/inbox", label: "Inbox" },
  { href: "/bounces", label: "Bounces" },
  { href: "/settings/accounts", label: "Accounts" },
  { href: "/settings/import", label: "Import" },
  { href: "/settings/geocoding", label: "Geocoding" },
  { href: "/settings/health", label: "Health" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen bg-neutral-950 text-neutral-100">
      <aside className="flex w-56 flex-col justify-between border-r border-neutral-800 p-4">
        <div>
          <div className="mb-6 px-2 text-lg font-semibold">MailFlow</div>
          <nav className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-50"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="px-2">
          <div className="mb-2 truncate text-xs text-neutral-500">{user?.email}</div>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
