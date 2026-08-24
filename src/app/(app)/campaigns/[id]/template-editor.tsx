"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { resolveMergeFields, resolveTemplate } from "@/lib/templates/resolve";
import { linkifyMarkdown, wrapInGmailQuote } from "@/lib/templates/emailHtml";
import {
  PREVIEW_CONTACT,
  makeBodyEditorExtensions,
  rawStringToContent,
  docToRawString,
} from "./rich-body-extensions";

type Template = {
  step_number: number;
  days_after_previous: number;
  test_delay_minutes: number | null;
  subject: string;
  body: string;
};

const MINUTES_PER_UNIT = { minutes: 1, hours: 60, days: 1440 } as const;
type DelayUnit = keyof typeof MINUTES_PER_UNIT;

function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0 && minutes > 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0 && minutes > 0) return `${minutes / 60} hr${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

type SavedTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

const MERGE_FIELDS = ["First Name", "Last Name", "Venue", "City", "State", "Venue Type"];

export function TemplateEditor({
  campaignId,
  templates,
  savedTemplates,
}: {
  campaignId: string;
  templates: Template[];
  savedTemplates: SavedTemplate[];
}) {
  const router = useRouter();
  const [editingStep, setEditingStep] = useState<number | null>(null);

  const nextStepNumber = templates.length > 0 ? Math.max(...templates.map((t) => t.step_number)) + 1 : 1;
  const firstStepTemplate = templates.find((t) => t.step_number === 1);

  return (
    <div className="mt-5 flex flex-col gap-3.5">
      {templates
        .sort((a, b) => a.step_number - b.step_number)
        .map((t) => (
          <StepForm
            key={t.step_number}
            campaignId={campaignId}
            template={t}
            savedTemplates={savedTemplates}
            firstStepTemplate={firstStepTemplate}
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
          template={{
            step_number: nextStepNumber,
            days_after_previous: nextStepNumber === 1 ? 0 : 5,
            test_delay_minutes: null,
            subject: "",
            body: "",
          }}
          savedTemplates={savedTemplates}
          firstStepTemplate={firstStepTemplate}
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
  savedTemplates,
  firstStepTemplate,
  isEditing,
  isNew,
  onEdit,
  onDone,
}: {
  campaignId: string;
  template: Template;
  savedTemplates: SavedTemplate[];
  firstStepTemplate?: Template;
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
  const [savingTemplate, setSavingTemplate] = useState(false);

  const [testDelayEnabled, setTestDelayEnabled] = useState(template.test_delay_minutes != null);
  const [testDelayAmount, setTestDelayAmount] = useState(
    template.test_delay_minutes != null ? String(template.test_delay_minutes) : "5",
  );
  const [testDelayUnit, setTestDelayUnit] = useState<DelayUnit>("minutes");

  const subjectRef = useRef<HTMLInputElement>(null);
  const activeFieldRef = useRef<"subject" | "body">("body");

  const bodyEditor = useEditor({
    extensions: makeBodyEditorExtensions("Hi {{First Name}}, ..."),
    content: rawStringToContent(template.body),
    immediatelyRender: false,
    onUpdate: ({ editor }) => setBody(docToRawString(editor.state.doc)),
    onFocus: () => (activeFieldRef.current = "body"),
    editorProps: {
      attributes: {
        class: "min-h-[160px] text-sm text-ink outline-none [&_p]:m-0",
      },
    },
  });

  /** Inserts `token` at the cursor of the Subject field. By default the
   * cursor lands after the inserted text; pass `selectInner` to instead
   * select a sub-range (offsets relative to the token's own start), so a
   * placeholder is immediately ready to type over. */
  function insertIntoSubject(token: string, selectInner?: [number, number]) {
    const target = subjectRef.current;
    const start = target?.selectionStart ?? subject.length;
    const end = target?.selectionEnd ?? subject.length;
    const nextValue = subject.slice(0, start) + token + subject.slice(end);
    setSubject(nextValue);

    const [selStart, selEnd] = selectInner
      ? [start + selectInner[0], start + selectInner[1]]
      : [start + token.length, start + token.length];
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(selStart, selEnd);
    });
  }

  function insertMergeField(field: string) {
    if (activeFieldRef.current === "subject") {
      insertIntoSubject(`{{${field}}}`);
      return;
    }
    bodyEditor?.chain().focus().insertContent({ type: "mergeField", attrs: { field } }).run();
  }

  function insertSpintext() {
    const token = "{option a|option b}";
    if (activeFieldRef.current === "subject") {
      insertIntoSubject(token, [1, token.length - 1]);
      return;
    }
    if (!bodyEditor) return;
    const from = bodyEditor.state.selection.from;
    bodyEditor
      .chain()
      .focus()
      .insertContentAt(from, token)
      .setTextSelection({ from: from + 1, to: from + token.length - 1 })
      .run();
  }

  /** Inserted as a real hyperlink in the body (a true `<a>` tag at send
   * time — see rich-body-extensions for how it's represented while
   * editing) or, in the single-line Subject field, as `[label](url)`
   * markdown-lite text, since Subject has no rich rendering. Selecting
   * text first uses it as the label; with nothing selected, a placeholder
   * label is inserted and pre-selected so it's immediately typeable. */
  function insertLink() {
    if (activeFieldRef.current === "subject") {
      const target = subjectRef.current;
      const start = target?.selectionStart ?? subject.length;
      const end = target?.selectionEnd ?? subject.length;
      const selectedText = subject.slice(start, end);

      const rawUrl = prompt(selectedText ? `Link "${selectedText}" to:` : "URL to insert:");
      if (!rawUrl?.trim()) return;
      const url = /^(https?:\/\/|mailto:)/i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;

      if (selectedText) {
        insertIntoSubject(`[${selectedText}](${url})`);
      } else {
        const label = "link text";
        insertIntoSubject(`[${label}](${url})`, [1, 1 + label.length]);
      }
      return;
    }

    if (!bodyEditor) return;
    const { from, to } = bodyEditor.state.selection;
    const selectedText = bodyEditor.state.doc.textBetween(from, to, "");

    const rawUrl = prompt(selectedText ? `Link "${selectedText}" to:` : "URL to insert:");
    if (!rawUrl?.trim()) return;
    const url = /^(https?:\/\/|mailto:)/i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;

    if (selectedText) {
      bodyEditor.chain().focus().setLink({ href: url }).run();
    } else {
      const label = "link text";
      bodyEditor
        .chain()
        .focus()
        .insertContentAt(from, label)
        .setTextSelection({ from, to: from + label.length })
        .setLink({ href: url })
        .run();
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaignId}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step_number: template.step_number,
        days_after_previous: daysAfter,
        test_delay_minutes: testDelayEnabled
          ? Math.max(0, Math.round((parseFloat(testDelayAmount) || 0) * MINUTES_PER_UNIT[testDelayUnit]))
          : null,
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

  function loadSavedTemplate(saved: SavedTemplate) {
    if ((subject.trim() || body.trim()) && !confirm(`Replace the current subject/body with "${saved.name}"?`)) return;
    setSubject(saved.subject);
    setBody(saved.body);
    bodyEditor?.commands.setContent(rawStringToContent(saved.body));
  }

  async function saveAsTemplate() {
    if (!body.trim()) return;
    const name = prompt("Save this step as a template named:");
    if (!name?.trim()) return;

    setSavingTemplate(true);
    setError(null);
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, subject, body }),
    });
    const data = await res.json();
    setSavingTemplate(false);
    if (!res.ok) {
      setError(data.error);
      return;
    }
    router.refresh();
  }

  async function deleteSavedTemplate(saved: SavedTemplate) {
    if (!confirm(`Delete saved template "${saved.name}"? This won't affect any campaign steps already using it.`)) return;
    await fetch("/api/templates", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: saved.id }),
    });
    router.refresh();
  }

  // The collapsed summary shows a resolved preview (merge fields filled in,
  // links rendered), matching how the body editor itself displays while
  // editing — spintext is deliberately left as raw `{a|b}` text rather than
  // resolved to one random pick, since there's no single fixed answer.
  const effectiveSubject = resolveMergeFields(
    template.subject.trim() ||
      (template.step_number > 1 && firstStepTemplate ? `Re: ${firstStepTemplate.subject}` : template.subject),
    PREVIEW_CONTACT,
  );
  const effectiveBodyHtml = linkifyMarkdown(resolveMergeFields(template.body, PREVIEW_CONTACT));

  if (!isEditing) {
    return (
      <div className="grid grid-cols-[36px_1fr] gap-4 border-t border-hairline-soft py-[18px]">
        <span className="font-display text-[22px] italic text-faint-2">
          {String(template.step_number).padStart(2, "0")}
        </span>
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold text-ink">{effectiveSubject}</span>
              {template.step_number > 1 && template.test_delay_minutes != null ? (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                  ⚠ TEST: {formatMinutes(template.test_delay_minutes)} after previous
                </span>
              ) : (
                template.step_number > 1 && (
                  <span className="text-[11px] text-faint">{template.days_after_previous} days after previous</span>
                )
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
          <div
            className="mt-1.5 whitespace-pre-wrap text-[13px] text-muted [&_a]:text-accent [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: effectiveBodyHtml }}
          />
          {template.step_number > 1 && (
            <p className="mt-1 text-[11px] text-faint-3">Sent as a reply, with step 1&apos;s original email quoted below.</p>
          )}
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

      {template.step_number > 1 && (
        <div className="mt-3 rounded-[2px] border border-warning/40 bg-warning/10 px-3 py-2.5">
          <label className="flex items-center gap-2 text-xs font-medium text-warning">
            <input
              type="checkbox"
              checked={testDelayEnabled}
              onChange={(e) => setTestDelayEnabled(e.target.checked)}
            />
            ⚠ Testing override — send after
          </label>
          {testDelayEnabled && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={testDelayAmount}
                onChange={(e) => setTestDelayAmount(e.target.value)}
                className="w-16 rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-xs text-ink outline-none"
              />
              <select
                value={testDelayUnit}
                onChange={(e) => setTestDelayUnit(e.target.value as DelayUnit)}
                className="rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-xs text-ink outline-none"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <span className="text-[11px] text-warning">instead of {daysAfter} days — uncheck when done testing</span>
            </div>
          )}
        </div>
      )}

      {savedTemplates.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-faint-2">Load template:</span>
          {savedTemplates.map((saved) => (
            <span
              key={saved.id}
              className="inline-flex items-center gap-1 rounded-[2px] border border-hairline px-2 py-1 text-[11px] text-muted-3"
            >
              <button type="button" onClick={() => loadSavedTemplate(saved)} className="hover:text-accent">
                {saved.name}
              </button>
              <button
                type="button"
                onClick={() => deleteSavedTemplate(saved)}
                title={`Delete "${saved.name}"`}
                className="text-faint-3 hover:text-error"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <label className="mt-3.5 block text-[10px] tracking-wide text-faint uppercase">Subject</label>
      <input
        ref={subjectRef}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onFocus={() => (activeFieldRef.current = "subject")}
        placeholder={
          template.step_number === 1
            ? "{Quick note|Reaching out} about {{Venue}}"
            : firstStepTemplate?.subject
              ? `Leave blank to auto-fill: "Re: ${firstStepTemplate.subject}"`
              : "Leave blank to auto-fill as a reply to step 1's subject"
        }
        className="mt-1.5 w-full border-0 border-b border-rule bg-transparent px-0.5 py-2 text-sm text-ink outline-none placeholder:text-faint-3"
      />
      {template.step_number > 1 && (
        <p className="mt-1 text-[11px] text-faint-3">
          This step is sent as a real reply — step 1&apos;s original email is quoted underneath automatically
          (always step 1, even from step 3 onward, so quotes don&apos;t pile up).
        </p>
      )}

      <label className="mt-4 block text-[10px] tracking-wide text-faint uppercase">
        Body — shown as it will actually look
      </label>
      <div
        onClick={() => bodyEditor?.chain().focus().run()}
        className="mt-1.5 w-full cursor-text rounded-[2px] border border-hairline bg-paper px-3 py-2.5"
      >
        <EditorContent editor={bodyEditor} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-faint-2">Insert:</span>
        {MERGE_FIELDS.map((field) => (
          <button
            key={field}
            type="button"
            onClick={() => insertMergeField(field)}
            className="rounded-[2px] border border-hairline px-2 py-1 text-[11px] text-muted-3 hover:border-accent hover:text-accent"
          >
            {field}
          </button>
        ))}
        <span className="mx-0.5 h-3.5 w-px bg-rule" />
        <button
          type="button"
          onClick={insertSpintext}
          title="Randomly picks one option each send: {option a|option b} — highlighted in the body, but stays as editable raw text since there's no single fixed result to show"
          className="rounded-[2px] border border-hairline px-2 py-1 text-[11px] text-muted-3 hover:border-accent hover:text-accent"
        >
          Spintext
        </button>
        <button
          type="button"
          onClick={insertLink}
          title="Select text first to link it, or insert a placeholder link at the cursor"
          className="rounded-[2px] border border-hairline px-2 py-1 text-[11px] text-muted-3 hover:border-accent hover:text-accent"
        >
          Link
        </button>
      </div>

      {template.step_number > 1 && firstStepTemplate && (
        <div className="mt-3.5">
          <label className="block text-[10px] tracking-wide text-faint uppercase">
            Appended automatically when sent
          </label>
          <div
            className="mt-1.5 whitespace-pre-wrap rounded-[2px] border border-hairline bg-paper p-3.5 text-xs text-faint-2 [&_a]:text-accent [&_a]:underline [&_blockquote]:my-1.5"
            dangerouslySetInnerHTML={{
              __html: wrapInGmailQuote(
                `On [send date], at [send time], [your sending address] wrote:<br>` +
                  linkifyMarkdown(resolveTemplate(firstStepTemplate.body, PREVIEW_CONTACT)).replace(/\n/g, "<br>"),
              ),
            }}
          />
          <p className="mt-1.5 text-[11px] text-faint-3">
            Always step 1&apos;s original email — the actual date/sender is filled in for real at send time; this
            is an approximation using step 1&apos;s current template.
          </p>
        </div>
      )}

      {error && <p className="mt-2.5 text-xs text-error">{error}</p>}

      <div className="mt-4 flex gap-3">
        <button
          onClick={save}
          disabled={saving || !body.trim() || (template.step_number === 1 && !subject.trim())}
          className="rounded-[2px] bg-ink px-3.5 py-2 text-xs font-semibold text-surface disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save step"}
        </button>
        <button onClick={onDone} className="px-1 py-2 text-xs text-muted-3 hover:text-ink">
          Cancel
        </button>
        <button
          onClick={saveAsTemplate}
          disabled={savingTemplate || !body.trim()}
          className="ml-auto text-xs text-muted-3 underline hover:text-accent disabled:opacity-50"
        >
          {savingTemplate ? "Saving template…" : "Save as template"}
        </button>
      </div>
    </div>
  );
}
