// The q idiom snippets (#944): the file is read, every idiom has what the
// completion list shows, and the provider lives only while
// q-lint.idiomSnippets.enable is on. That each body is q the linter accepts
// is `tests/snippets.rs`; that q parses each is idioms_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { stub, vscode } = require("./vscode_stub");
const { readIdioms, wordStart, preview } = require("../out/idioms.js");
const { registerIdioms } = require("../out/idiomsview.js");
const pkg = require("../package.json");

const root = path.join(__dirname, "..");
const text = fs.readFileSync(path.join(root, "snippets", "idioms.json"), "utf8");

test("the idioms cover the joins, the .z handlers and a TorQ process, each with a description", () => {
  const idioms = readIdioms(text);
  const prefixes = idioms.map((i) => i.prefix);
  for (const p of ["aj", "aj0", "wj", "wj1", "lj", "ij", "uj", "xbar", "zpg", "zps", "zpo", "zpc", "zpw", "zts", "zws", "zexit", "torq"]) {
    assert.ok(prefixes.includes(p), `${p} is offered`);
  }
  assert.strictEqual(new Set(prefixes).size, prefixes.length, "no prefix twice");
  for (const idiom of idioms) {
    assert.match(idiom.prefix, /^[a-z][a-z0-9]*$/, `${idiom.name}: a word, so it completes as one is typed`);
    assert.ok(idiom.description.length > 20, idiom.name);
    assert.ok(idiom.body.length > 0, idiom.name);
  }
  // Not contributed through package.json, which has no switch.
  assert.ok(!pkg.contributes.snippets.some((s) => s.path.includes("idioms")));
});

test("the word being typed, dots and all, is what is replaced; the preview shows the defaults", () => {
  assert.strictEqual(wordStart("x:.z.p", 6), 2);
  assert.strictEqual(wordStart("  aj", 4), 2);
  assert.strictEqual(wordStart("f[", 2), 2);
  // After a drop written without spaces the name alone is the word (#1992).
  for (const [line, word] of [["x:1_aj", "aj"], ["r:-1_tra", "tra"], ["0x00_x", "x"], ["1_2_.z.p", ".z.p"], ["t _tra", "tra"], ["2024.01.02_d", "d"], ["a1_b", "a1_b"], ["x_1", "x_1"], ["x:12", "12"], ["1_", ""]]) {
    assert.strictEqual(line.slice(wordStart(line, line.length)), word, line);
  }
  assert.strictEqual(preview("aj[`${1:sym}`${2:time};${3:t};${4:q}]$0"), "aj[`sym`time;t;q]");
  assert.strictEqual(preview("w:${1:-0D00:00:01 0D00:00:00}+\\\\:${2:t}"), "w:-0D00:00:01 0D00:00:00+\\:t");
  assert.strictEqual(preview("${1:a ${2:b}} \\$x"), "a b $x");
});

test("the switch is declared on, and off disposes the provider", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.idiomSnippets.enable"].default, true);
  stub.reset();
  const registered = [];
  vscode.languages = {
    registerCompletionItemProvider: (selector, provider) => {
      const entry = { selector, provider, disposed: false, dispose() { this.disposed = true; } };
      registered.push(entry);
      return entry;
    },
  };
  vscode.CompletionItem = class {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  };
  vscode.SnippetString = class {
    constructor(value) {
      this.value = value;
    }
  };
  vscode.Range = class {
    constructor(a, b, c, d) {
      Object.assign(this, { a, b, c, d });
    }
  };
  const context = { ...stub.newContext(), extensionPath: root };
  const idioms = registerIdioms(context);
  assert.strictEqual(registered.length, 1);
  const document = { lineAt: () => ({ text: "  .z.p" }) };
  const items = registered[0].provider.provideCompletionItems(document, { line: 3, character: 6 });
  const zpg = items.find((i) => i.label.label === "zpg");
  assert.strictEqual(zpg.insertText.value, ".z.pg:{[x] ${1:value x}}");
  assert.deepStrictEqual(zpg.range, new vscode.Range(3, 2, 3, 6));
  assert.strictEqual(zpg.label.description, "Synchronous message handler");
  stub.config.user["idiomSnippets.enable"] = false;
  stub.changeConfig("q-lint.idiomSnippets.enable");
  assert.strictEqual(registered[0].disposed, true);
  assert.strictEqual(idioms.registered(), false);
  assert.deepStrictEqual(idioms.items(document, { line: 3, character: 6 }), []);
  stub.config.user["idiomSnippets.enable"] = true;
  stub.changeConfig("q-lint.idiomSnippets.enable");
  assert.strictEqual(registered.length, 2);
});
