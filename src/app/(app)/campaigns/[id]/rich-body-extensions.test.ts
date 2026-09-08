import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { flattenParagraphsToSingle, makeBodyEditorExtensions } from "./rich-body-extensions";

// A real schema built from the editor's actual extension set — the same
// one `useEditor` constructs in the app — rather than a hand-rolled stand-in,
// so a schema change (e.g. renaming a node) would break this test too.
const schema = getSchema(makeBodyEditorExtensions(""));

function paragraph(text: string) {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}

function textOf(node: ReturnType<typeof paragraph>): string {
  let out = "";
  node.content.forEach((child) => {
    if (child.type.name === "hardBreak") out += "\n";
    else out += child.text ?? "";
  });
  return out;
}

describe("flattenParagraphsToSingle", () => {
  it("returns null when there's nothing to flatten (0 or 1 paragraphs)", () => {
    expect(flattenParagraphsToSingle(schema, schema.nodes.doc.create().content)).toBeNull();
    const oneParagraph = schema.nodes.doc.create(null, [paragraph("solo")]).content;
    expect(flattenParagraphsToSingle(schema, oneParagraph)).toBeNull();
  });

  it("collapses a paragraph boundary between two tight lines to a single break", () => {
    const frag = schema.nodes.doc.create(null, [paragraph("Line A"), paragraph("Line B")]).content;
    const result = flattenParagraphsToSingle(schema, frag);
    expect(result).not.toBeNull();
    expect(textOf(result!)).toBe("Line A\nLine B");
  });

  it("preserves exactly one blank line when the source has an empty paragraph between two others", () => {
    const emptyPara = schema.nodes.paragraph.create();
    const frag = schema.nodes.doc.create(null, [paragraph("Para 1"), emptyPara, paragraph("Para 2")]).content;
    const result = flattenParagraphsToSingle(schema, frag);
    expect(textOf(result!)).toBe("Para 1\n\nPara 2");
  });

  it("doesn't invent a blank line between every line the way the un-flattened paste used to", () => {
    const frag = schema.nodes.doc.create(null, [
      paragraph("THE LITTLE MERCIES — A rising force"),
      paragraph("CHARLIE & THE TROPICALES — Calypso, cumbia"),
      paragraph("SAMIR LANGUS — Moroccan trance music, rewired in New York"),
    ]).content;
    const result = flattenParagraphsToSingle(schema, frag);
    const text = textOf(result!);
    expect(text).toBe(
      "THE LITTLE MERCIES — A rising force\nCHARLIE & THE TROPICALES — Calypso, cumbia\nSAMIR LANGUS — Moroccan trance music, rewired in New York",
    );
    expect(text).not.toMatch(/\n\n/);
  });

  it("preserves inline marks (bold/italic/link) carried on the original paragraphs' content", () => {
    const bold = schema.nodes.paragraph.create(null, schema.text("Bold line", [schema.marks.bold.create()]));
    const plain = paragraph("Plain line");
    const frag = schema.nodes.doc.create(null, [bold, plain]).content;
    const result = flattenParagraphsToSingle(schema, frag);
    const firstChild = result!.content.firstChild!;
    expect(firstChild.marks.some((m) => m.type.name === "bold")).toBe(true);
  });
});
