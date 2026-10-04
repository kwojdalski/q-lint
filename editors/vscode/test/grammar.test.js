// The q grammar, tokenized by the engine VS Code itself uses. Each case pins
// a scope the grammar was written or fixed to produce, and the near-miss that
// must not get it - colouring regressions are otherwise invisible until
// someone opens a file and notices.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const tm = require("vscode-textmate");
const og = require("vscode-oniguruma");

const grammarPath = path.join(__dirname, "..", "syntaxes", "q.tmLanguage.json");
const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
const onig = og.loadWASM(wasm).then(() => ({
  createOnigScanner: (p) => new og.OnigScanner(p),
  createOnigString: (s) => new og.OnigString(s),
}));
const registry = new tm.Registry({
  onigLib: onig,
  loadGrammar: async (scope) =>
    scope === "source.q" ? tm.parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath) : null,
});
const grammar = registry.loadGrammar("source.q");

// The innermost scope of each token whose text is `text`, in order.
async function scopesOf(source, text) {
  const g = await grammar;
  let stack = tm.INITIAL;
  const found = [];
  for (const line of source.split("\n")) {
    const r = g.tokenizeLine(line, stack);
    for (const t of r.tokens) {
      if (line.slice(t.startIndex, t.endIndex) === text) found.push(t.scopes[t.scopes.length - 1]);
    }
    stack = r.ruleStack;
  }
  return found;
}

const cases = [
  // [description, source, token text, expected innermost scope, which occurrence]
  ["a name assigned a lambda is a function", "f:{x+1}", "f", "entity.name.function.q"],
  ["its declared parameters are parameters", "f:{[a;b] a+b}", "b", "variable.parameter.q", 0],
  ["the implicit x is the language's", "f:{x+1}", "x", "variable.language.implicit.q"],
  ["an amend assigns, as a plain assignment does", "n+:1", "+:", "keyword.operator.assignment.q"],
  ["a return opens an expression", "f:{if[x;:1];2}", ":", "keyword.control.flow.return.q", 1],
  ["a signal opens an expression", "f:{'`bad}", "'", "keyword.control.flow.signal.q"],
  ["after an operand the quote is each, even with a space", "r:{x} '[1 2]", "'", "keyword.operator.iterator.q"],
  ["and the colon of @[d;i;:;v] is the assignment function", "r:@[d;0;:;5]", ":", "keyword.operator.q", 1],
  ["a dotted name's namespace is a namespace", "r:.cfg.lim+1", ".cfg", "entity.name.namespace.q"],
  ["a builtin is a builtin", "r:sum 1 2", "sum", "support.function.builtin.q"],
  ["a .z name is the system's", "r:.z.p", ".z.p", "support.function.system.q"],
  ["a file handle is a handle", "h:`:data/x", "`:data/x", "constant.other.symbol.handle.q"],
  ["an escape q defines is an escape", 's:"a\\tb"', "\\t", "constant.character.escape.q"],
  ["one it does not is illegal", 's:"a\\qb"', "\\q", "invalid.illegal.escape.q"],
  ["a temporal literal is temporal", "d:2024.01.02", "2024.01.02", "constant.numeric.temporal.q"],
  ["a typed null is a null", "x:0Nd", "0Nd", "constant.language.null.q"],
];

for (const [description, source, text, scope, which = -1] of cases) {
  test(description, async () => {
    const scopes = await scopesOf(source, text);
    assert.ok(scopes.length > 0, `no token ${JSON.stringify(text)} in ${JSON.stringify(source)}`);
    const at = which < 0 ? scopes.length - 1 : which;
    assert.strictEqual(scopes[at], scope, `${JSON.stringify(text)} in ${JSON.stringify(source)}: ${scopes}`);
  });
}

test("a slash after whitespace opens a comment, and one after a value is over", async () => {
  assert.deepStrictEqual(await scopesOf("x:1 / note", "/"), ["punctuation.definition.comment.q"]);
  assert.deepStrictEqual(await scopesOf("r:+/1 2", "/"), ["keyword.operator.iterator.q"]);
});

test("a lone backslash ends the script, and what follows is comment", async () => {
  const scopes = await scopesOf("x:1\n\\\ny:2", "y:2");
  assert.ok(scopes[0].startsWith("comment.block.end-of-script.q"), scopes[0]);
});
