import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";
import { NavTabs } from "./nav-tabs";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-hairline bg-surface">
        <div className="mx-auto max-w-[1080px] px-8 pt-5">
          <div className="flex items-baseline justify-between">
            <div className="font-display text-2xl italic">Mailflow</div>
            <div className="flex items-center gap-4 text-xs text-muted-3">
              <span>{user?.email}</span>
              <SignOutButton />
            </div>
          </div>
          <div className="mt-[22px]">
            <NavTabs />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1080px] px-8 py-10 pb-20">{children}</main>
    </div>
  );
}
