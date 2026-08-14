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
    <div className="mt-3 flex flex-col gap-4">
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
          className="self-start rounded-md border border-dashed border-neutral-700 px-3 py-1.5 text-sm text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
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
      <div className="rounded-lg border border-neutral-800 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-neutral-100">
            Step {template.step_number}
            {template.step_number > 1 && (
              <span className="ml-2 text-xs font-normal text-neutral-500">
                {template.days_after_previous} days after previous
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onEdit} className="text-xs text-neutral-400 hover:text-neutral-100">
              Edit
            </button>
            <button onClick={remove} className="text-xs text-red-400 hover:text-red-300">
              Delete
            </button>
          </div>
        </div>
        <div className="mt-2 text-sm text-neutral-300">{template.subject}</div>
        <div className="mt-1 whitespace-pre-wrap text-xs text-neutral-500">{template.body}</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-4">
      <div className="text-sm font-medium text-neutral-100">
        {isNew ? `New step ${template.step_number}` : `Editing step ${template.step_number}`}
      </div>

      {template.step_number > 1 && (
        <label className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
          Days after previous step
          <input
            type="number"
            min={0}
            value={daysAfter}
            onChange={(e) => setDaysAfter(parseInt(e.target.value) || 0)}
            className="w-16 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100"
          />
        </label>
      )}

      <label className="mt-3 block text-xs text-neutral-400">Subject</label>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="{Quick note|Reaching out} about {{Venue}}"
        className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
      />

      <label className="mt-3 block text-xs text-neutral-400">Body</label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        placeholder={`Hi {{First Name}},\n\n...`}
        className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100"
      />
      <p className="mt-1 text-xs text-neutral-600">
        Spintext: {"{option a|option b}"}. Merge fields: {MERGE_FIELD_HELP}
      </p>

      <button
        onClick={() => setShowPreview((s) => !s)}
        className="mt-2 text-xs text-neutral-400 underline hover:text-neutral-200"
      >
        {showPreview ? "Hide" : "Show"} preview
      </button>
      {showPreview && (
        <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs">
          <div className="text-neutral-300">{resolveTemplate(subject, PREVIEW_CONTACT)}</div>
          <div className="mt-1 whitespace-pre-wrap text-neutral-500">
            {resolveTemplate(body, PREVIEW_CONTACT)}
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          onClick={save}
          disabled={saving || !subject.trim() || !body.trim()}
          className="rounded-md bg-neutral-50 px-3 py-1.5 text-xs font-medium text-neutral-950 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save step"}
        </button>
        <button onClick={onDone} className="rounded-md px-3 py-1.5 text-xs text-neutral-400">
          Cancel
        </button>
      </div>
    </div>
  );
}
