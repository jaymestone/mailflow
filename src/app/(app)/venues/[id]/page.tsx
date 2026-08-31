import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ContactDetailClient } from "./contact-detail-client";

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: contact }, { data: lists }, { data: notes }] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", id).single(),
    supabase.from("lists").select("id, name").order("name"),
    supabase.from("contact_notes").select("id, body, created_at").eq("contact_id", id).order("created_at", { ascending: false }),
  ]);

  if (!contact) notFound();

  return (
    <div>
      <Link href="/venues" className="text-xs text-muted-3 hover:text-accent">
        ← Venues
      </Link>
      <div className="mt-2.5">
        <h1 className="font-display text-[32px] font-medium text-ink">
          {[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email}
        </h1>
        {contact.venue && <p className="mt-1 font-display text-[15px] italic text-muted-2">{contact.venue}</p>}
      </div>

      <div className="mt-8">
        <ContactDetailClient contact={contact} lists={lists ?? []} initialNotes={notes ?? []} />
      </div>
    </div>
  );
}
