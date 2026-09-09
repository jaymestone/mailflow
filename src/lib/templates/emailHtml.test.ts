import { describe, expect, it } from "vitest";
import { escapeHtml, linkifyMarkdown, markdownToEmailHtml, wrapEmailHtml } from "./emailHtml";

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

describe("wrapEmailHtml", () => {
  it("does not set white-space:pre-wrap", () => {
    // Regression guard for the reply-doubling bug: pre-wrap here, combined
    // with an email client (confirmed: Gmail) re-serializing the HTML when
    // quoting it into a reply, makes the client's own incidental
    // formatting newlines render as real line breaks on top of the
    // deliberate <br> tags -- doubling every line, but only once something
    // gets quoted, never on a fresh send. Space preservation must come
    // from markdownToEmailHtml's &nbsp; substitution instead.
    expect(wrapEmailHtml("hi")).not.toContain("pre-wrap");
    expect(wrapEmailHtml("hi")).not.toContain("white-space");
  });
});

describe("markdownToEmailHtml", () => {
  it("converts newlines to <br> with no literal newline left in the output", () => {
    const result = markdownToEmailHtml("line one\nline two\n\nline three");
    expect(result).toBe("line one<br>line two<br><br>line three");
    expect(result).not.toContain("\n");
  });

  it("preserves a multi-space run (e.g. an indent) as alternating space/&nbsp;", () => {
    expect(markdownToEmailHtml("    [ARTIST](https://example.com) — tagline")).toBe(
      '&nbsp;&nbsp;&nbsp; <a href="https://example.com">ARTIST</a> — tagline',
    );
  });

  it("leaves a single space alone", () => {
    expect(markdownToEmailHtml("one space between words")).toBe("one space between words");
  });

  it("doesn't double up spacing across multiple indented lines (the reported bug's exact shape)", () => {
    const body =
      "Hi Val,\n\nHope you're thriving.\n\n    [THE LITTLE MERCIES](https://example.com/a) — old-time\n    [SAMIR LANGUS](https://example.com/b) — Moroccan trance";
    const result = markdownToEmailHtml(body);
    // Exactly one <br> between the two indented artist lines -- not two.
    expect(result).toContain("old-time<br>&nbsp;&nbsp;&nbsp; <a");
    expect(result).not.toMatch(/<br>\s*<br>\s*&nbsp;&nbsp;&nbsp; <a[^>]*>SAMIR/);
  });
});

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">it's & "that"</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;that&quot;&lt;/a&gt;",
    );
  });
});
