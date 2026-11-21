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
// k, for the `k)` lines q embeds it in.
const kPath = path.join(__dirname, "..", "syntaxes", "k.tmLanguage.json");
const registry = new tm.Registry({
  onigLib: onig,
  loadGrammar: async (scope) =>
    scope === "source.q"
      ? tm.parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath)
      : scope === "source.k"
        ? tm.parseRawGrammar(fs.readFileSync(kPath, "utf8"), kPath)
        : null,
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
  // A lambda's body opens after its parameter list, so a return or signal
  // there is the first thing in it: KDB-X's {[x]:x+1} 2 is 3.
  ["a return right after the parameter list", "f:{[x]:x+1}", ":", "keyword.control.flow.return.q", 1],
  ["and after a space", "f:{[x] :x+1}", ":", "keyword.control.flow.return.q", 1],
  ["a signal right after the parameter list", "f:{[x] 'x}", "'", "keyword.control.flow.signal.q"],
  ["after an operand the quote is each, even with a space", "r:{x} '[1 2]", "'", "keyword.operator.iterator.q"],
  ["and the colon of @[d;i;:;v] is the assignment function", "r:@[d;0;:;5]", ":", "keyword.operator.q", 1],
  ["a dotted name's namespace is a namespace", "r:.cfg.lim+1", ".cfg", "entity.name.namespace.q"],
  ["a builtin is a builtin", "r:sum 1 2", "sum", "support.function.builtin.q"],
  ["a .z name is the system's", "r:.z.p", ".z.p", "support.function.system.q"],
  ["a file handle is a handle", "h:`:data/x", "`:data/x", "constant.other.symbol.handle.q"],
  // As KDB-X parses them: past a colon a symbol takes slashes, and a minus
  // ends a handle (`:a-b is `:a minus b).
  ["a slash after a symbol's colon is in the symbol", "s:`a:b/c", "`a:b/c", "constant.other.symbol.q"],
  ["a minus ends a handle", "h:`:a-b", "`:a", "constant.other.symbol.handle.q"],
  ["an escape q defines is an escape", 's:"a\\tb"', "\\t", "constant.character.escape.q"],
  ["one it does not is illegal", 's:"a\\qb"', "\\q", "invalid.illegal.escape.q"],
  ["a temporal literal is temporal", "d:2024.01.02", "2024.01.02", "constant.numeric.temporal.q"],
  ["a typed null is a null", "x:0Nd", "0Nd", "constant.language.null.q"],
  // Each as KDB-X reads it: a time's fraction is any length, a time with
  // more than three places is a timespan, a date may carry p or z, and an
  // exponent may be E.
  ["a time with one decimal place is one time", "t:10:00:00.1", "10:00:00.1", "constant.numeric.temporal.q"],
  ["a time with nine places is a timespan, still one literal", "t:12:00:00.123456789", "12:00:00.123456789", "constant.numeric.temporal.q"],
  ["a second past 99 hours is one literal", "t:100:00:00", "100:00:00", "constant.numeric.temporal.q"],
  ["a date made a timestamp with p is one literal", "d:2024.01.02p", "2024.01.02p", "constant.numeric.temporal.q"],
  ["and made a datetime with z", "d:2024.01.02z", "2024.01.02z", "constant.numeric.temporal.q"],
  ["an upper-case exponent is part of the number", "n:1.5E3", "1.5E3", "constant.numeric.q"],
  // A number with p is a timestamp that many hours past 2000: KDB-X and
  // PeachQ read 1p as 2000.01.01D01:00:00.000000000.
  ["a number made a timestamp with p is one literal", "t:1p", "1p", "constant.numeric.q"],
  ["and a fractional one", "t:1.5p", "1.5p", "constant.numeric.q"],
];

// What KDB-X refuses: there is no typed null or infinity of symbol (the
// null symbol is a lone backtick), and no infinite guid.
test("0Ns, 0Ws and 0Wg are not coloured as nulls, since q refuses them", async () => {
  for (const text of ["0Ns", "0ns", "0Ws", "-0ws", "0Wg"]) {
    assert.notDeepStrictEqual(await scopesOf(`x:${text}`, text), ["constant.language.null.q"], text);
  }
  for (const text of ["0Ng", "0Nc", "0Wc", "-0Wp", "0wz"]) {
    assert.deepStrictEqual(await scopesOf(`x:${text}`, text), ["constant.language.null.q"], text);
  }
});

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

test("a k) line is k, coloured by the k grammar, and the next q line is q again", async () => {
  const g = await grammar;
  const first = g.tokenizeLine("k)x+1 2 3", tm.INITIAL);
  const plus = first.tokens.find((t) => "k)x+1 2 3".slice(t.startIndex, t.endIndex) === "+");
  assert.ok(plus.scopes.includes("source.k"), JSON.stringify(plus.scopes));
  assert.ok(plus.scopes.includes("meta.embedded.block.k.q"), JSON.stringify(plus.scopes));
  const next = g.tokenizeLine("f:{x+1}", first.ruleStack);
  const f = next.tokens.find((t) => "f:{x+1}".slice(t.startIndex, t.endIndex) === "f");
  assert.ok(!f.scopes.includes("source.k"), JSON.stringify(f.scopes));
});
