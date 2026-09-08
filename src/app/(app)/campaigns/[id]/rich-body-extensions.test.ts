import { describe, expect, it } from "vitest";
import { normalizePastedHtml } from "./rich-body-extensions";

describe("normalizePastedHtml", () => {
  it("collapses a paragraph boundary between two tight lines to a single break", () => {
    expect(normalizePastedHtml("<p>Line A</p><p>Line B</p>")).toBe("Line A<br>Line B");
  });

  it("preserves exactly one blank line when the source has one empty paragraph between two others", () => {
    expect(normalizePastedHtml("<p>Para 1</p><p></p><p>Para 2</p>")).toBe("Para 1<br><br>Para 2");
  });

  it("doesn't invent a blank line between every line the way the un-normalized paste used to", () => {
    const pasted =
      "<p>THE LITTLE MERCIES — A rising force</p><p>CHARLIE &amp; THE TROPICALES — Calypso, cumbia</p><p>AMANDA PASCALI — Gen Z troubadour</p>";
    const result = normalizePastedHtml(pasted);
    expect(result).toBe(
      "THE LITTLE MERCIES — A rising force<br>CHARLIE &amp; THE TROPICALES — Calypso, cumbia<br>AMANDA PASCALI — Gen Z troubadour",
    );
    expect(result).not.toMatch(/<br>\s*<br>/);
  });

  it("strips the outer wrapping tag without adding a stray leading/trailing break", () => {
    expect(normalizePastedHtml("<div>Just one line</div>")).toBe("Just one line");
  });

  it("treats div and heading boundaries the same as paragraph boundaries", () => {
    expect(normalizePastedHtml("<div>Line A</div><h2>Line B</h2><div>Line C</div>")).toBe("Line A<br>Line B<br>Line C");
  });

  it("handles attributes on the block tags (e.g. pasted from a styled source)", () => {
    expect(normalizePastedHtml('<p style="margin:0">Line A</p><p class="x">Line B</p>')).toBe("Line A<br>Line B");
  });
});
