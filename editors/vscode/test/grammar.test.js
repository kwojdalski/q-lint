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
        : scope === "source.python"
          ? // A stand-in: what matters is where the embedded block ends.
            tm.parseRawGrammar(JSON.stringify({ scopeName: "source.python", patterns: [] }), "python.json")
          : null,
});
const grammar = registry.loadGrammar("source.q");
const kGrammar = registry.loadGrammar("source.k");

// The innermost scope of each token whose text is `text`, in order; `k` for
// a k file's.
async function scopesOf(source, text, k = false) {
  const g = await (k ? kGrammar : grammar);
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

// x, y and z are a lambda's implicit parameters only when it declares none:
// in {[a] x+a} x is a global, as KDB-X reads it.
test("x is not an implicit parameter of a lambda that declares its own", async () => {
  assert.deepStrictEqual(await scopesOf("f:{[a] x+a}", "x"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("f:{[a;b]\n  y*a}", "y"), ["variable.other.q"]);
  // A declared x is the parameter; an undeclared one in a nested lambda
  // with no list is that lambda's own.
  assert.deepStrictEqual(await scopesOf("f:{[x] x+1}", "x"), ["variable.parameter.q", "variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("f:{[a] {x+1} a}", "x"), ["variable.language.implicit.q"]);
});

test("a parameter list over several lines is a parameter list", async () => {
  const src = "f:{[a;\n  b]\n  a+b}";
  assert.deepStrictEqual(await scopesOf(src, "b"), ["variable.parameter.q", "variable.other.q"]);
  assert.deepStrictEqual(await scopesOf(src, "a"), ["variable.parameter.q", "variable.other.q"]);
  assert.deepStrictEqual(await scopesOf(src, "]"), ["punctuation.definition.parameters.end.q"]);
  // And the lambda still ends where it closes.
  assert.deepStrictEqual(await scopesOf(src + "\ng:1", "g"), ["variable.other.definition.q"]);
});

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

test("a p) block runs on past a blank line to the next indented one, and ends at column 0", async () => {
  const g = await grammar;
  let stack = tm.INITIAL;
  const embedded = {};
  for (const line of ["p)def f(x):", "    y = x", "", "    return y", "", "z:1"]) {
    const r = g.tokenizeLine(line, stack);
    for (const t of r.tokens) {
      const word = line.slice(t.startIndex, t.endIndex).trim();
      if (word !== "") embedded[word] = t.scopes.includes("meta.embedded.block.python.q");
    }
    stack = r.ruleStack;
  }
  assert.strictEqual(embedded["return y"] ?? embedded.return, true, JSON.stringify(embedded));
  assert.strictEqual(embedded.z ?? embedded["z:1"], false, JSON.stringify(embedded));
  // A k) block likewise.
  const k1 = g.tokenizeLine("k)f:{x+", tm.INITIAL);
  const k2 = g.tokenizeLine("", k1.ruleStack);
  const k3 = g.tokenizeLine(" 1}", k2.ruleStack);
  assert.ok(k3.tokens.every((t) => t.scopes.includes("meta.embedded.block.k.q")), JSON.stringify(k3.tokens));
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

// As KDB-X tokenizes them (-4!): "1_til 5" is 1, _, til, 5 and "(1)_x" ends
// _, x, while "a_1+a_b" is a_1, +, a_b and "`a_x" one symbol. Only an
// underscore inside a name belongs to it.
test("an underscore after a literal or a bracket is drop: what it joins keeps its colour (#1971)", async () => {
  assert.deepStrictEqual(await scopesOf("r:1_til 5", "1"), ["constant.numeric.q"]);
  assert.deepStrictEqual(await scopesOf("r:1_til 5", "til"), ["support.function.builtin.q"]);
  assert.deepStrictEqual(await scopesOf("j:{-1_string x}", "1"), ["constant.numeric.q"]);
  assert.deepStrictEqual(await scopesOf("j:{-1_string x}", "string"), ["support.function.builtin.q"]);
  assert.deepStrictEqual(await scopesOf("j:{1_x}", "x"), ["variable.language.implicit.q"]);
  assert.deepStrictEqual(await scopesOf("f:(-1)_y", "y"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("g:f[x]_y", "y"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("h:til[3]_2", "2"), ["constant.numeric.q"]);
  assert.deepStrictEqual(await scopesOf("h:x _y", "y"), ["variable.other.q"]);
  for (const [literal, scope] of [["2024.01.02", "constant.numeric.temporal.q"], ["0N", "constant.language.null.q"], ["1b", "constant.language.boolean.q"], ["0x01", "constant.numeric.byte.q"], ["1e3", "constant.numeric.q"]]) {
    assert.deepStrictEqual(await scopesOf(`r:${literal}_v`, literal), [scope], literal);
    assert.deepStrictEqual(await scopesOf(`r:${literal}_v`, "v"), ["variable.other.q"], literal);
  }
  // One inside a name is the name's: no builtin, number or implicit
  // parameter starts after it.
  assert.deepStrictEqual(await scopesOf("r:a_1+a_b", "a_1"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("r:a_1+a_b", "a_b"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("r:a_til", "a_til"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("r:count_x", "count_x"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("f:{x_1+a_x}", "x_1"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("f:{x_1+a_x}", "a_x"), ["variable.other.q"]);
  assert.deepStrictEqual(await scopesOf("r:.z.p_x", ".z.p_x"), ["support.function.system.q"]);
  assert.deepStrictEqual(await scopesOf("r:`a_x", "`a_x"), ["constant.other.symbol.q"]);
  assert.deepStrictEqual(await scopesOf("a_b:1", "a_b"), ["variable.other.definition.q"]);
  // The same in a k file.
  assert.deepStrictEqual(await scopesOf("f:{1_x}", "1", true), ["constant.numeric.k"]);
  assert.deepStrictEqual(await scopesOf("f:{1_x}", "x", true), ["variable.language.implicit.k"]);
  assert.deepStrictEqual(await scopesOf("r:(1)_y", "y", true), ["variable.other.k"]);
  assert.deepStrictEqual(await scopesOf("f:{x_1+a_b}", "x_1", true), ["variable.other.k"]);
  assert.deepStrictEqual(await scopesOf("f:{x_1+a_b}", "a_b", true), ["variable.other.k"]);
});

// Checked on KDB-X by evaluating "\<c>" for every printable c and every
// three octal digits: after a backslash q takes n, r, t, a quote, a
// backslash and a slash, and the octals 000 to 377. "\400" is an error, and
// so are "\1" and "\12".
test("a string's escapes are the ones q takes: a slash is one, an octal past 377 is not (#1972)", async () => {
  assert.deepStrictEqual(await scopesOf('u:"http:\\/\\/x"', "\\/"), ["constant.character.escape.q", "constant.character.escape.q"]);
  assert.deepStrictEqual(await scopesOf('s:"a\\377b"', "\\377"), ["constant.character.escape.q"]);
  assert.deepStrictEqual(await scopesOf('s:"a\\000b"', "\\000"), ["constant.character.escape.q"]);
  assert.deepStrictEqual(await scopesOf('s:"a\\400b"', "\\4"), ["invalid.illegal.escape.q"]);
  assert.deepStrictEqual(await scopesOf('s:"a\\777b"', "\\7"), ["invalid.illegal.escape.q"]);
  assert.deepStrictEqual(await scopesOf('s:"a\\12b"', "\\1"), ["invalid.illegal.escape.q"]);
  // The slash escape opens no comment and ends no string.
  assert.deepStrictEqual(await scopesOf('u:"a \\/ b";v:1', "v"), ["variable.other.definition.q"]);
  // The same in a k file.
  assert.deepStrictEqual(await scopesOf('u:"a\\/b"', "\\/", true), ["constant.character.escape.k"]);
  assert.deepStrictEqual(await scopesOf('s:"a\\400b"', "\\4", true), ["invalid.illegal.escape.k"]);
});

// On KDB-X ('[neg;count]) 1 2 3 and (')[neg;count] 1 2 3 are -3, '[neg;count]
// opens a line or a lambda the same way, and {'[`bad]} 1 returns `bad' - a
// quote before a bracket never raises. {'(`bad)} and {' `bad} do.
test("a quote before a bracket or a closing parenthesis is the iterator, not a signal (#1973)", async () => {
  const iterator = (await scopesOf("r:{x} '[1 2]", "'"))[0];
  assert.match(iterator, /iterator/);
  assert.deepStrictEqual(await scopesOf("h:('[neg;count]) 1 2", "'"), [iterator]);
  assert.deepStrictEqual(await scopesOf("i:(')[neg;count]", "'"), [iterator]);
  assert.deepStrictEqual(await scopesOf("'[neg;count] 1 2 3", "'"), [iterator]);
  assert.deepStrictEqual(await scopesOf("j:{'[neg;count] x}", "'"), [iterator]);
  assert.deepStrictEqual(await scopesOf("k:{[f;g] '[f;g]}", "'"), [iterator]);
  // What is composed keeps its own colours.
  assert.deepStrictEqual(await scopesOf("h:('[neg;count]) 1 2", "neg"), ["support.function.builtin.q"]);
  // A signal is still one, a parenthesised operand included.
  assert.deepStrictEqual(await scopesOf("f:{'(`bad)}", "'"), ["keyword.control.flow.signal.q"]);
  assert.deepStrictEqual(await scopesOf("f:{' `bad}", "'"), ["keyword.control.flow.signal.q"]);
  assert.deepStrictEqual(await scopesOf("f:{$[x;'`bad;1]}", "'"), ["keyword.control.flow.signal.q"]);
  assert.deepStrictEqual(await scopesOf("f:('`bad)", "'"), ["keyword.control.flow.signal.q"]);
});

// On KDB-X a script of "#!/usr/bin/env q" then "sh1:1" loads and sh1 is 1,
// a .k one the same; with the #! line second the load fails with '#.
test("a script's #! first line is a comment, and only the first line (#1974)", async () => {
  const script = "#!/usr/bin/env q\nsh1:1 / set";
  assert.deepStrictEqual(await scopesOf(script, "#!/usr/bin/env q"), ["comment.line.shebang.q"]);
  assert.deepStrictEqual(await scopesOf(script, "bin"), []);
  assert.deepStrictEqual(await scopesOf(script, "sh1"), ["variable.other.definition.q"]);
  // Anywhere else q reads it as code, so it is coloured as code.
  const second = "sh2:1\n#!/usr/bin/env q";
  assert.deepStrictEqual(await scopesOf(second, "#!/usr/bin/env q"), []);
  assert.deepStrictEqual(await scopesOf(second, "bin"), ["support.function.builtin.q"]);
  assert.deepStrictEqual(await scopesOf("r:1#!/usr", "#!/usr"), []);
  // The same in a k file.
  assert.deepStrictEqual(await scopesOf("#!/bin/k\nsh4:1", "#!/bin/k", true), ["comment.line.shebang.k"]);
  assert.deepStrictEqual(await scopesOf("#!/bin/k\nsh4:1", "sh4", true), ["variable.other.k"]);
  assert.deepStrictEqual(await scopesOf("sh4:1\n#!/bin/k", "#!/bin/k", true), []);
});
