import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../scripts/fe-archive-assets.js", import.meta.url), "utf8");
const start = source.indexOf("export function feSerializeBodyToParts(");
const serialize = runInNewContext(source.slice(start, source.indexOf("\n}", start) + 2).replace(/^export /, "")
  + "\nfeSerializeBodyToParts", { feSnapshotAndRestoreStickyScroll: () => () => {} });

// Minimal node tree: Set-backed children keep moving 150,000 nodes linear-time.
function tree(count, { failShell = false, failMessage = false } = {}) {
  const makeParent = () => ({
    nodes: new Set(), get childNodes() { return [...this.nodes]; },
    get children() { return [...this.nodes]; },
    appendChild(node) {
      if (node.nodes) { for (const child of [...node.nodes]) this.appendChild(child); return node; }
      node.remove(); this.nodes.add(node); node.parent = this; return node;
    },
    append(...nodes) { for (const node of nodes) this.appendChild(node); },
  });
  const doc = { createDocumentFragment: makeParent, createElement: () => ({
    replaceChildren(node) { this.innerHTML = node.markup; }, innerHTML: "",
  }) };
  const log = makeParent();
  log.ownerDocument = doc;
  Object.defineProperty(log, "outerHTML", { get() {
    return `<ol class="chat-log">${[...log.nodes].map(node => node.outerHTML).join("")}</ol>`;
  } });
  for (let index = 0; index < count; index++) {
    const node = { parent: log, remove() { this.parent?.nodes.delete(this); this.parent = null; },
      get outerHTML() { if (failMessage && index === 1) throw new Error("message serialization failed"); return `<li>${index}</li>`; } };
    log.nodes.add(node);
  }
  const original = [...log.nodes];
  const body = { ownerDocument: doc, querySelector: () => log,
    get outerHTML() { if (failShell && log.nodes.size === 0) throw new Error("shell failed"); return `<body>${log.outerHTML}</body>`; } };
  return { body, log, original };
}

test("very large logs serialize and restore without the function-argument limit", () => {
  const { body, log, original } = tree(150_000);
  const parts = serialize(body);
  assert.equal(log.nodes.size, 150_000);
  assert.equal(parts.length, 150_002);
  assert.equal(parts[1], "<li>0</li>");
  assert.equal(parts.at(-2), "<li>149999</li>");
  assert.deepEqual([...log.nodes], original);
});

test("shell serialization failure still restores every live message in order", () => {
  const { body, log, original } = tree(3, { failShell: true });
  assert.equal(serialize(body).join(""), "<body><ol class=\"chat-log\"><li>0</li><li>1</li><li>2</li></ol></body>");
  assert.deepEqual([...log.nodes], original);
});

test("an unserializable message cannot silently become a successful incomplete archive", () => {
  const { body, log, original } = tree(3, { failMessage: true });
  assert.throws(() => serialize(body), /message serialization failed/);
  assert.deepEqual([...log.nodes], original);
});

test("text and comments keep their position and HTML escaping between messages", () => {
  const { body, log, original } = tree(2);
  const text = { parent: log, remove() { this.parent?.nodes.delete(this); this.parent = null; },
    cloneNode() { return { markup: "&lt;not-markup&gt; &amp; text<!--note-->" }; } };
  log.nodes = new Set([original[0], text, original[1]]);
  const parts = serialize(body);
  assert.equal(parts.join(""), '<body><ol class="chat-log"><li>0</li>&lt;not-markup&gt; &amp; text<!--note--><li>1</li></ol></body>');
  assert.deepEqual([...log.nodes], [original[0], text, original[1]]);
});

test("a log passed directly as the snapshot root also uses chunked serialization", () => {
  const { log } = tree(3);
  log.matches = () => true;
  const parts = serialize(log);
  assert.equal(parts.length, 5);
  assert.equal(parts.join(""), '<ol class="chat-log"><li>0</li><li>1</li><li>2</li></ol>');
});
