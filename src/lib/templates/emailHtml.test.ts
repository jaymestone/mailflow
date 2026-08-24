import { describe, expect, it } from "vitest";
import { escapeHtml, linkifyMarkdown } from "./emailHtml";

describe("linkifyMarkdown", () => {
  it("converts a markdown-lite link into a real anchor tag", () => {
    expect(linkifyMarkdown("[click here](https://example.com)")).toBe('<a href="https://example.com">click here</a>');
  });

  it("converts bold, italic, and combined bold-italic markup", () => {
    expect(linkifyMarkdown("**bold**")).toBe("<strong>bold</strong>");
    expect(linkifyMarkdown("*italic*")).toBe("<em>italic</em>");
    expect(linkifyMarkdown("***both***")).toBe("<strong><em>both</em></strong>");
  });

  it("doesn't let a longer asterisk run get swallowed by a shorter alternative", () => {
    expect(linkifyMarkdown("**bold** and *italic* and ***both***")).toBe(
      "<strong>bold</strong> and <em>italic</em> and <strong><em>both</em></strong>",
    );
  });

  it("escapes HTML-significant characters before converting markup", () => {
    expect(linkifyMarkdown("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("does not treat an underscore inside a linked URL as italic markup", () => {
    // Italic uses "*" specifically so this case is a non-issue, but this
    // pins down that a real-world URL survives the conversion untouched.
    const result = linkifyMarkdown("[docs](https://example.com/foo_bar_baz)");
    expect(result).toBe('<a href="https://example.com/foo_bar_baz">docs</a>');
  });

  it("does not let a link's URL get misread for emphasis markup", () => {
    const result = linkifyMarkdown("[compare](https://example.com/a*b) then **bold**");
    expect(result).toBe('<a href="https://example.com/a*b">compare</a> then <strong>bold</strong>');
  });

  it("leaves plain text with no markup untouched", () => {
    expect(linkifyMarkdown("just a normal sentence")).toBe("just a normal sentence");
  });
});

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">it's & "that"</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;that&quot;&lt;/a&gt;",
    );
  });
});
