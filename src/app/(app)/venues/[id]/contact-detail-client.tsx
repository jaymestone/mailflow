"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ContactHistoryToggle } from "../../_shared/contact-history";

type Contact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  venue: string | null;
  venue_type: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  notes: string | null;
  source: string | null;
  mobile: string | null;
  phone: string | null;
  website: string | null;
  list_id: string | null;
};

type Note = { id: string; body: string; created_at: string };

const FIELDS: { key: keyof Contact; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "venue", label: "Venue" },
  { key: "venue_type", label: "Venue type" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "mobile", label: "Mobile" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "source", label: "Source" },
];

export function ContactDetailClient({
  contact,
  lists,
  initialNotes,
}: {
  contact: Contact;
  lists: { id: string; name: string }[];
  initialNotes: Note[];
}) {
  const router = useRouter();
  const [form, setForm] = useState<Contact>(contact);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  function setField(key: keyof Contact, value: string) {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const { id: _id, ...editable } = form;
    void _id;
    const res = await fetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editable),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.error);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  async function deleteContact() {
    if (!confirm(`Permanently delete ${form.email}? This removes their entire send/reply history too. This can't be undone.`))
      return;
    await fetch(`/api/contacts/${contact.id}`, { method: "DELETE" });
    router.push("/venues");
  }

  async function addNote() {
    if (!newNote.trim()) return;
    setAddingNote(true);
    const res = await fetch(`/api/contacts/${contact.id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: newNote.trim() }),
    });
    const data = await res.json();
    setAddingNote(false);
    if (res.ok) {
      setNotes((n) => [data.note, ...n]);
      setNewNote("");
    }
  }

  async function deleteNote(noteId: string) {
    if (!confirm("Delete this note?")) return;
    await fetch(`/api/contacts/${contact.id}/notes`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId }),
    });
    setNotes((n) => n.filter((note) => note.id !== noteId));
  }

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px]">
      <div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-4">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="block text-[10px] tracking-wide text-faint uppercase">{f.label}</span>
              <input
                value={(form[f.key] as string | null) ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
                className="mt-1.5 w-full border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-sm text-ink outline-none placeholder:text-faint-3"
              />
            </label>
          ))}
          <label className="block">
            <span className="block text-[10px] tracking-wide text-faint uppercase">List</span>
            <select
              value={form.list_id ?? ""}
              onChange={(e) => setField("list_id", e.target.value)}
              className="mt-1.5 w-full border-0 border-b border-rule bg-transparent px-0.5 py-1.5 text-sm text-ink outline-none"
            >
              <option value="">Unassigned</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-4 block">
          <span className="block text-[10px] tracking-wide text-faint uppercase">Notes</span>
          <textarea
            value={form.notes ?? ""}
            onChange={(e) => setField("notes", e.target.value)}
            rows={3}
            className="mt-1.5 w-full rounded-[2px] border border-hairline bg-paper px-2.5 py-2 text-sm text-ink outline-none"
          />
        </label>

        {error && <p className="mt-2.5 text-xs text-error">{error}</p>}

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-[2px] bg-ink px-3.5 py-2 text-xs font-semibold text-surface disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="text-xs text-success">Saved</span>}
          <button onClick={deleteContact} className="ml-auto text-xs text-error hover:underline">
            Delete contact
          </button>
        </div>

        <div className="mt-9">
          <h2 className="text-[10px] tracking-wide text-faint uppercase">Campaign history</h2>
          <div className="mt-2">
            <ContactHistoryToggle contactId={contact.id} />
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-[10px] tracking-wide text-faint uppercase">Activity notes</h2>
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Called, left a voicemail…"
            rows={2}
            className="w-full rounded-[2px] border border-hairline bg-paper px-2.5 py-2 text-xs text-ink outline-none placeholder:text-faint-3"
          />
          <button
            onClick={addNote}
            disabled={addingNote || !newNote.trim()}
            className="self-start rounded-[2px] border border-hairline px-3 py-1.5 text-[11px] text-muted-3 hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {addingNote ? "Adding…" : "Add note"}
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          {notes.map((note) => (
            <div key={note.id} className="rounded-[2px] border border-hairline-soft bg-paper p-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap text-xs text-ink-soft">{note.body}</p>
                <button onClick={() => deleteNote(note.id)} className="shrink-0 text-faint-3 hover:text-error">
                  ×
                </button>
              </div>
              <p className="mt-1 text-[10px] text-faint-2">{new Date(note.created_at).toLocaleString()}</p>
            </div>
          ))}
          {notes.length === 0 && <p className="text-xs text-muted-3">No notes yet.</p>}
        </div>
      </div>
    </div>
  );
}
