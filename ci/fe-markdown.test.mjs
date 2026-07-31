/**
 * Node unit tests for the PURE helpers of fe-markdown.js.
 *
 * Run from the module root:
 *   node --test ci/fe-markdown.test.mjs
 *
 * fe-markdown.js imports only fe-constants.js (no side effects) and
 * fe-gm-priority.js (feSetting is read lazily at call time, never at import),
 * so the pure formatting helpers need no global stubs to import or exercise.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  feEscapeHTML,
  feInlineFormat,
  feMarkdownToHTML,
  feLooksLikeHTML,
  feUnwrapProseMirrorHTML,
} from "../scripts/fe-markdown.js";

// ── feEscapeHTML ──────────────────────────────────────────────────────────────

test("feEscapeHTML escapes the five HTML-significant characters", () => {
  assert.equal(
    feEscapeHTML(`<a href="x">&'`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&#039;",
  );
});

test("feEscapeHTML coerces null/undefined to an empty string", () => {
  assert.equal(feEscapeHTML(null), "");
  assert.equal(feEscapeHTML(undefined), "");
});

// ── feInlineFormat: emphasis ──────────────────────────────────────────────────

test("feInlineFormat renders bold, italic, strikethrough and code", () => {
  assert.equal(feInlineFormat("**b**"), "<strong>b</strong>");
  assert.equal(feInlineFormat("_i_"), "<em>i</em>");
  assert.equal(feInlineFormat("~~s~~"), "<s>s</s>");
  assert.equal(feInlineFormat("`c`"), "<code>c</code>");
});

test("feInlineFormat escapes HTML inside a code span", () => {
  assert.equal(feInlineFormat("`<b>`"), "<code>&lt;b&gt;</code>");
});

test("feMarkdownToHTML does not double-escape code span content", () => {
  assert.equal(feMarkdownToHTML("`<b>`"), "<p><code>&lt;b&gt;</code></p>");
});

test("feInlineFormat does not treat intraword underscores as emphasis", () => {
  assert.equal(feInlineFormat("foo_bar_baz"), "foo_bar_baz");
  assert.equal(feInlineFormat("앞_중간_뒤"), "앞_중간_뒤");
  assert.equal(feInlineFormat("a _italic_ word"), "a <em>italic</em> word");
});

test("feInlineFormat protects literal text from placeholder collisions", () => {
  assert.equal(
    feInlineFormat("FECODE0 and `x`"),
    "FECODE0 and <code>x</code>",
  );
});

// ── feInlineFormat: link safety (security-critical) ───────────────────────────

test("feInlineFormat keeps http(s) links as anchors", () => {
  const out = feInlineFormat("[label](https://example.com)");
  assert.match(out, /^<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">label<\/a>$/);
});

test("feInlineFormat drops a javascript: link, leaving only the label text", () => {
  const out = feInlineFormat("[click](javascript:alert(1))");
  assert.doesNotMatch(out, /<a\b/);
  assert.doesNotMatch(out, /javascript:/i);
  assert.match(out, /click/);
});

test("feInlineFormat drops a data: link", () => {
  const out = feInlineFormat("[x](data:text/html;base64,PHNjcmlwdD4=)");
  assert.doesNotMatch(out, /<a\b/);
  assert.doesNotMatch(out, /data:/i);
});

test("feInlineFormat does not double-encode ampersands in a query string", () => {
  const out = feInlineFormat("[q](https://e.com/?a=1&b=2)");
  assert.match(out, /href="https:\/\/e\.com\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(out, /&amp;amp;/);
});

test("feInlineFormat does not parse underscores inside link or image attributes", () => {
  assert.equal(
    feInlineFormat("[label](https://example.com/a_b_c)"),
    '<a href="https://example.com/a_b_c" target="_blank" rel="noopener noreferrer">label</a>',
  );
  assert.equal(
    feInlineFormat("![alt](images/a_b_c.webp)"),
    '<img src="images/a_b_c.webp" alt="alt">',
  );
});

test("feInlineFormat formats link labels while keeping generated markup protected", () => {
  assert.equal(
    feInlineFormat("[**bold** and `code`](https://example.com)"),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer"><strong>bold</strong> and <code>code</code></a>',
  );
});

test("feInlineFormat drops unsafe image schemes", () => {
  const out = feInlineFormat("![alt](data:image/svg+xml,bad)");
  assert.doesNotMatch(out, /<img\b/);
  assert.doesNotMatch(out, /data:/i);
  assert.equal(out, "alt");
});

// ── feMarkdownToHTML: block structure ─────────────────────────────────────────

test("feMarkdownToHTML renders headings h1..h6", () => {
  assert.equal(feMarkdownToHTML("# Title"), "<h1>Title</h1>");
  assert.equal(feMarkdownToHTML("###### Deep"), "<h6>Deep</h6>");
  // 7+ hashes are NOT a heading (regex caps at 6) — left as a paragraph.
  assert.equal(feMarkdownToHTML("####### Deep"), "<p>####### Deep</p>");
});

test("feMarkdownToHTML renders a fenced code block with a sanitized language class", () => {
  const out = feMarkdownToHTML("```js!@#\nconst x = 1 < 2;\n```");
  assert.match(out, /<pre><code class="language-js">/);
  // Code body is HTML-escaped.
  assert.match(out, /const x = 1 &lt; 2;/);
});

test("feMarkdownToHTML renders an unordered list", () => {
  assert.equal(feMarkdownToHTML("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

test("feMarkdownToHTML renders blockquotes and horizontal rules", () => {
  assert.equal(feMarkdownToHTML("> quoted"), "<blockquote><p>quoted</p></blockquote>");
  assert.equal(feMarkdownToHTML("---"), "<hr>");
});

test("feMarkdownToHTML joins a multi-line paragraph with <br>", () => {
  assert.equal(feMarkdownToHTML("line1\nline2"), "<p>line1<br>line2</p>");
});

test("feMarkdownToHTML leaves ordered lists as literal paragraph text", () => {
  // Ordered lists are intentionally NOT converted.
  assert.equal(feMarkdownToHTML("1. first"), "<p>1. first</p>");
});

// ── feLooksLikeHTML ───────────────────────────────────────────────────────────

test("feLooksLikeHTML detects real tags but not bare angle brackets", () => {
  assert.equal(feLooksLikeHTML("<p>hi</p>"), true);
  assert.equal(feLooksLikeHTML("2 < 3 and 5 > 1"), false);
});

// ── feUnwrapProseMirrorHTML ───────────────────────────────────────────────────

test("feUnwrapProseMirrorHTML unwraps pure paragraph/br output to plain text", () => {
  assert.equal(feUnwrapProseMirrorHTML("<p>hello</p>"), "hello");
  assert.equal(feUnwrapProseMirrorHTML("<p>a</p><p>b</p>"), "a\n\nb");
  assert.equal(feUnwrapProseMirrorHTML("<p>a<br>b</p>"), "a\nb");
});

test("feUnwrapProseMirrorHTML returns null when real HTML elements are present", () => {
  assert.equal(feUnwrapProseMirrorHTML("<p><span>x</span></p>"), null);
  assert.equal(feUnwrapProseMirrorHTML("<div>x</div>"), null);
});

test("feUnwrapProseMirrorHTML decodes entities the serializer produced", () => {
  assert.equal(feUnwrapProseMirrorHTML("<p>a &amp; b &lt;c&gt;</p>"), "a & b <c>");
});
