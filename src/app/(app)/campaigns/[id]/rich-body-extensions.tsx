"use client";

import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { HardBreak } from "@tiptap/extension-hard-break";
import { History } from "@tiptap/extension-history";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Extension, Node, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { resolveMergeFields } from "@/lib/templates/resolve";

/** The same sample contact the "how it will look" preview and the merge
 * field chips both resolve against, so the two stay consistent. */
export const PREVIEW_CONTACT = {
  first_name: "Jane",
  last_name: "Doe",
  venue: "Example Venue",
  city: "Austin",
  state: "TX",
};

function mergeFieldPreviewValue(field: string): string {
  return resolveMergeFields(`{{${field}}}`, PREVIEW_CONTACT);
}

function MergeFieldChipView({ node }: NodeViewProps) {
  const field: string = node.attrs.field;
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      title={`{{${field}}}`}
      className="mx-0.5 inline-block select-none rounded-full bg-accent/15 px-2 py-0.5 align-baseline text-[12px] font-medium text-accent"
    >
      {mergeFieldPreviewValue(field)}
    </NodeViewWrapper>
  );
}

/** Renders as the resolved preview value (e.g. "Jane") in a small pill —
 * showing the actual "end result" inline, the way it'll read to a real
 * recipient — while staying a single deletable unit that serializes back
 * to `{{Field Name}}` in the stored template string. */
export const MergeField = Node.create({
  name: "mergeField",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { field: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-merge-field]",
        getAttrs: (el) => ({ field: (el as HTMLElement).getAttribute("data-merge-field") || "" }),
      },
    ];
  },
  renderHTML({ node }) {
    return ["span", { "data-merge-field": node.attrs.field }, node.attrs.field];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MergeFieldChipView);
  },
});

const SPINTEXT_RE = /\{[^{}]+\|[^{}]*\}/g;
const spintextPluginKey = new PluginKey("spintextHighlight");

/** Spintext (`{option a|option b}`) has no single "end result" — it picks
 * randomly at send time — so unlike merge fields it stays as plain,
 * fully-editable text. This just highlights it visually via a ProseMirror
 * decoration, which never touches the actual document content. */
export const Spintext = Extension.create({
  name: "spintextHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: spintextPluginKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              for (const match of node.text.matchAll(SPINTEXT_RE)) {
                const from = pos + (match.index ?? 0);
                const to = from + match[0].length;
                decorations.push(
                  Decoration.inline(from, to, {
                    class: "rounded-[2px] bg-warning/15 text-warning",
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/** A single-paragraph document with Enter inserting a line break rather
 * than splitting into a new block — the raw storage format is plain text
 * with newlines, not multi-paragraph HTML, so there's only ever one
 * paragraph to keep serialization simple and unambiguous. */
const HardBreakOnEnter = HardBreak.extend({
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.setHardBreak(),
      "Shift-Enter": () => this.editor.commands.setHardBreak(),
    };
  },
});

export function makeBodyEditorExtensions(placeholder: string) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreakOnEnter,
    History,
    Link.configure({ autolink: false, openOnClick: false, linkOnPaste: false }),
    MergeField,
    Spintext,
    Placeholder.configure({ placeholder }),
  ];
}

const TOKEN_RE = /\{\{([^{}]+)\}\}|\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;

/** Parses the raw stored template string (with `{{Field}}` / spintext /
 * `[label](url)` syntax) into the editor's initial document. */
export function rawStringToContent(raw: string): JSONContent {
  const content: JSONContent[] = [];

  function pushText(text: string) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line) content.push({ type: "text", text: line });
      if (i < lines.length - 1) content.push({ type: "hardBreak" });
    });
  }

  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(raw))) {
    if (match.index > lastIndex) pushText(raw.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      content.push({ type: "mergeField", attrs: { field: match[1] } });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      content.push({ type: "text", text: match[2], marks: [{ type: "link", attrs: { href: match[3] } }] });
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < raw.length) pushText(raw.slice(lastIndex));

  return { type: "doc", content: [{ type: "paragraph", content }] };
}

/** Inverse of `rawStringToContent` — serializes the editor's document back
 * to the same raw template string format that's actually stored and sent,
 * so the rest of the app (merge-field/spintext resolution, the send
 * pipeline) never has to know a rich editor is involved. */
export function docToRawString(doc: PMNode): string {
  let result = "";
  // The editor is designed around a single paragraph (Enter inserts a
  // hardBreak, not a new paragraph — see HardBreakOnEnter above), but that's
  // only enforced for typing, not paste: pasting multi-paragraph content
  // (from Gmail, Word, a webpage) isn't intercepted and produces multiple
  // sibling paragraph nodes. Without this separator, the walk below would
  // concatenate the end of one paragraph directly against the start of the
  // next with nothing between them, silently squashing words together.
  let isFirstParagraph = true;
  doc.descendants((node) => {
    if (node.type.name === "paragraph") {
      if (!isFirstParagraph) result += "\n\n";
      isFirstParagraph = false;
      return true;
    }
    if (node.type.name === "hardBreak") {
      result += "\n";
      return false;
    }
    if (node.type.name === "mergeField") {
      result += `{{${node.attrs.field}}}`;
      return false;
    }
    if (node.isText) {
      const linkMark = node.marks.find((m) => m.type.name === "link");
      if (linkMark) {
        // A "]" in the label would break re-parsing on reload — `[label]`
        // uses it as the label's own closing delimiter. The label is
        // ordinary editable text under the Link mark (not an atomic node),
        // so it can pick up a "]" from typing after creation, not only from
        // the Link button — stripped here, the actual serialization
        // boundary, so it's caught regardless of how it got there.
        const safeLabel = (node.text ?? "").replace(/\]/g, "");
        result += `[${safeLabel}](${linkMark.attrs.href})`;
      } else {
        result += node.text ?? "";
      }
      return false;
    }
    return true;
  });
  return result;
}
