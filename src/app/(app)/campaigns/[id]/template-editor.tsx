"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { resolveTemplate } from "@/lib/templates/resolve";

type Template = {
  step_number: number;
  days_after_previous: number;
  subject: string;
  body: string;
};

const PREVIEW_CONTACT = {
  first_name: "Jane",
  last_name: "Doe",
  venue: "Example Venue",
  city: "Austin",
  state: "TX",
};

const MERGE_FIELD_HELP = "{{First Name}} {{Last Name}} {{Venue}} {{City}} {{State}} {{Venue Type}}";

export function TemplateEditor({ campaignId, templates }: { campaignId: string; templates: Template[] }) {
  const router = useRouter();
  const [editingStep, setEditingStep] = useState<number | null>(null);

  const nextStepNumber = templates.length > 0 ? Math.max(...templates.map((t) => t.step_number)) + 1 : 1;

  return (
    <div className="mt-5 flex flex-col gap-3.5">
      {templates
        .sort((a, b) => a.step_number - b.step_number)
        .map((t) => (
          <StepForm
            key={t.step_number}
            campaignId={campaignId}
            template={t}
            isEditing={editingStep === t.step_number}
            onEdit={() => setEditingStep(t.step_number)}
            onDone={() => {
              setEditingStep(null);
              router.refresh();
            }}
          />
        ))}

      {editingStep === nextStepNumber ? (
        <StepForm
          campaignId={campaignId}
          template={{ step_number: nextStepNumber, days_after_previous: nextStepNumber === 1 ? 0 : 5, subject: "", body: "" }}
          isEditing
          isNew
          onEdit={() => {}}
          onDone={() => {
            setEditingStep(null);
            router.refresh();
          }}
        />
      ) : (
        <button
          onClick={() => setEditingStep(nextStepNumber)}
          className="self-start rounded-[2px] border border-dashed border-rule px-3.5 py-2 text-xs text-muted-3 hover:border-accent hover:text-accent"
        >
          + Add step {nextStepNumber}
        </button>
      )}
    </div>
  );
}

function StepForm({
  campaignId,
  template,
  isEditing,
  isNew,
  onEdit,
  onDone,
}: {
  campaignId: string;
  template: Template;
  isEditing: boolean;
  isNew?: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [daysAfter, setDaysAfter] = useState(template.days_after_previous);
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaignId}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step_number: template.step_number,
        days_after_previous: daysAfter,
        subject,
        body,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.error);
      return;
    }
    onDone();
  }

  async function remove() {
    if (!confirm(`Delete step ${template.step_number}?`)) return;
    await fetch(`/api/campaigns/${campaignId}/templates`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step_number: template.step_number }),
    });
    router.refresh();
  }

  if (!isEditing) {
    return (
      <div className="grid grid-cols-[36px_1fr] gap-4 border-t border-hairline-soft py-[18px]">
        <span className="font-display text-[22px] italic text-faint-2">
          {String(template.step_number).padStart(2, "0")}
        </span>
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold text-ink">{template.subject}</span>
              {template.step_number > 1 && (
                <span className="text-[11px] text-faint">{template.days_after_previous} days after previous</span>
              )}
            </div>
            <div className="flex shrink-0 gap-3">
              <button onClick={onEdit} className="text-xs text-muted-3 hover:text-accent">
                Edit
              </button>
              <button onClick={remove} className="text-xs text-error hover:underline">
                Delete
              </button>
            </div>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-muted">{template.body}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[2px] border border-hairline-strong bg-surface p-5">
      <div className="text-sm font-semibold text-ink">
        {isNew ? `New step ${template.step_number}` : `Editing step ${template.step_number}`}
      </div>

      {template.step_number > 1 && (
        <label className="mt-3.5 flex items-center gap-2 text-xs text-muted-3">
          Days after previous step
          <input
            type="number"
            min={0}
            value={daysAfter}
            onChange={(e) => setDaysAfter(parseInt(e.target.value) || 0)}
            className="w-16 border-0 border-b border-rule bg-transparent px-0.5 py-1 text-ink outline-none"
          />
        </label>
      )}

      <label className="mt-3.5 block text-[10px] tracking-wide text-faint uppercase">Subject</label>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="{Quick note|Reaching out} about {{Venue}}"
        className="mt-1.5 w-full border-0 border-b border-rule bg-transparent px-0.5 py-2 text-sm text-ink outline-none placeholder:text-faint-3"
      />

      <label className="mt-4 block text-[10px] tracking-wide text-faint uppercase">Body</label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        placeholder={`Hi {{First Name}},\n\n...`}
        className="mt-1.5 w-full rounded-[2px] border border-hairline bg-paper px-3 py-2.5 font-mono text-xs text-ink outline-none placeholder:text-faint-3"
      />
      <p className="mt-2 text-xs text-faint-2">
        Spintext: {"{option a|option b}"}. Merge fields: {MERGE_FIELD_HELP}
      </p>

      <button
        onClick={() => setShowPreview((s) => !s)}
        className="mt-2.5 text-xs text-muted-3 underline hover:text-accent"
      >
        {showPreview ? "Hide" : "Show"} preview
      </button>
      {showPreview && (
        <div className="mt-2.5 rounded-[2px] border border-hairline bg-paper p-3.5 text-xs">
          <div className="text-ink-soft">{resolveTemplate(subject, PREVIEW_CONTACT)}</div>
          <div className="mt-1.5 whitespace-pre-wrap text-muted-2">{resolveTemplate(body, PREVIEW_CONTACT)}</div>
        </div>
      )}

      {error && <p className="mt-2.5 text-xs text-error">{error}</p>}

      <div className="mt-4 flex gap-3">
        <button
          onClick={save}
          disabled={saving || !subject.trim() || !body.trim()}
          className="rounded-[2px] bg-ink px-3.5 py-2 text-xs font-semibold text-surface disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save step"}
        </button>
        <button onClick={onDone} className="px-1 py-2 text-xs text-muted-3 hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}
