// q and k in Markdown's fenced blocks (#1163): the injection grammar the
// manifest contributes, tokenized by the engine VS Code uses inside a
// stand-in for Markdown's own grammar, which this repository does not ship.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const tm = require("vscode-textmate");
const og = require("vscode-oniguruma");
const pkg = require("../package.json");

const root = path.join(__dirname, "..");
const INJECTION = "markdown.q.codeblock";
const injection = pkg.contributes.grammars.find((g) => g.scopeName === INJECTION);

/// Markdown, as far as a fence needs: every line a paragraph.
const markdown = {
  scopeName: "text.html.markdown",
  patterns: [{ match: ".+", name: "meta.paragraph.markdown" }],
};
const files = { "source.q": "q.tmLanguage.json", "source.k": "k.tmLanguage.json" };
const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
const registry = new tm.Registry({
  onigLib: og.loadWASM(wasm).then(() => ({
    createOnigScanner: (p) => new og.OnigScanner(p),
    createOnigString: (s) => new og.OnigString(s),
  })),
  loadGrammar: async (scope) => {
    if (scope === "text.html.markdown") return markdown;
    const file = scope === INJECTION ? path.join(root, injection.path) : files[scope] && path.join(root, "syntaxes", files[scope]);
    return file ? tm.parseRawGrammar(fs.readFileSync(file, "utf8"), file) : null;
  },
  // What `injectTo` asks VS Code to do.
  getInjections: (scope) => (injection.injectTo.includes(scope) ? [INJECTION] : undefined),
});

/// Every scope of each token whose text is `text`, in order.
async function tokens(source, text) {
  const g = await registry.loadGrammar("text.html.markdown");
  let stack = tm.INITIAL;
  const found = [];
  for (const line of source.split("\n")) {
    const r = g.tokenizeLine(line, stack);
    for (const t of r.tokens) {
      if (line.slice(t.startIndex, t.endIndex) === text) found.push(t.scopes);
    }
    stack = r.ruleStack;
  }
  return found;
}

test("the manifest injects the grammar into Markdown, with q and k as its embedded languages", () => {
  assert.deepStrictEqual(injection.injectTo, ["text.html.markdown"]);
  assert.strictEqual(injection.language, undefined, "an injection belongs to no language of its own");
  assert.deepStrictEqual(injection.embeddedLanguages, { "meta.embedded.block.q": "q", "meta.embedded.block.k": "k" });
  const grammar = JSON.parse(fs.readFileSync(path.join(root, injection.path), "utf8"));
  assert.strictEqual(grammar.scopeName, INJECTION);
  // L: so its fences are tried before Markdown's plain one.
  assert.strictEqual(grammar.injectionSelector, "L:text.html.markdown");
  const embedded = (rule) => rule.patterns[0];
  assert.strictEqual(embedded(grammar.repository.fenced_code_block_q).contentName, "meta.embedded.block.q");
  assert.deepStrictEqual(embedded(grammar.repository.fenced_code_block_q).patterns, [{ include: "source.q" }]);
  assert.strictEqual(embedded(grammar.repository.fenced_code_block_k).contentName, "meta.embedded.block.k");
  assert.deepStrictEqual(embedded(grammar.repository.fenced_code_block_k).patterns, [{ include: "source.k" }]);
});

test("a ```q fence is coloured as q, and the text after it is Markdown again", async () => {
  const doc = "Some prose.\n\n```q\nf:{x+1}\n```\n\nf:{x+1} in prose";
  const [inFence] = await tokens(doc, "f");
  const [inProse] = await tokens(doc, "f:{x+1} in prose");
  assert.ok(inFence.includes("markup.fenced_code.block.markdown"), JSON.stringify(inFence));
  assert.ok(inFence.includes("meta.embedded.block.q"), JSON.stringify(inFence));
  assert.strictEqual(inFence[inFence.length - 1], "entity.name.function.q");
  assert.ok(!inProse.some((s) => s.endsWith(".q")), JSON.stringify(inProse));
  // The fence's language is named as Markdown names one.
  const [lang] = await tokens(doc, "q");
  assert.ok(lang.includes("fenced_code.block.language.markdown"), JSON.stringify(lang));
});

test("so is a ~~~ fence, an indented one and one with attributes; kdb+ names q too", async () => {
  for (const doc of ["~~~q\nf:{x+1}\n~~~", "  ```q\n  f:{x+1}\n  ```", "```q title=\"a\"\nf:{x+1}\n```", "```kdb+\nf:{x+1}\n```", "```Q\nf:{x+1}\n```"]) {
    const [scopes] = await tokens(doc, "f");
    assert.ok(scopes?.includes("meta.embedded.block.q"), `${JSON.stringify(doc)}: ${JSON.stringify(scopes)}`);
  }
});

test("a ```k fence is coloured as k", async () => {
  const [scopes] = await tokens("```k\nf:{x+1}\n```", "+");
  assert.ok(scopes.includes("meta.embedded.block.k"), JSON.stringify(scopes));
  assert.strictEqual(scopes[scopes.length - 1], "keyword.operator.k");
  assert.ok(!scopes.some((s) => s.endsWith(".q")), JSON.stringify(scopes));
});

test("a fence of another language, or one whose name only starts with q, is left to Markdown", async () => {
  for (const doc of ["```python\nf=1\n```", "```qsql\nf:1\n```", "```kotlin\nf=1\n```", "```\nf:1\n```"]) {
    const [scopes] = await tokens(doc, doc.includes("=") ? "f=1" : "f:1");
    assert.ok(!scopes.some((s) => s.startsWith("meta.embedded")), `${JSON.stringify(doc)}: ${JSON.stringify(scopes)}`);
  }
});
