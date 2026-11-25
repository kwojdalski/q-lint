// The languages this extension colours but does not lint (#890): k, qcumber
// specs and the query output channel, tokenized by the engine VS Code itself
// uses, and the manifest that wires them. As in grammar.test.js, each case
// pins a scope a rule was written to produce and the near-miss that must not
// get it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const tm = require("vscode-textmate");
const og = require("vscode-oniguruma");
const pkg = require("../package.json");
const { LINTED } = require("../out/settings.js");

const root = path.join(__dirname, "..");
const files = {
  "source.q": "q.tmLanguage.json",
  "source.k": "k.tmLanguage.json",
  "source.quke": "quke.tmLanguage.json",
  "source.q-console": "q-console.tmLanguage.json",
};
const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
const onig = og.loadWASM(wasm).then(() => ({
  createOnigScanner: (p) => new og.OnigScanner(p),
  createOnigString: (s) => new og.OnigString(s),
}));
const registry = new tm.Registry({
  onigLib: onig,
  loadGrammar: async (scope) => {
    if (!files[scope]) return null;
    const file = path.join(root, "syntaxes", files[scope]);
    return tm.parseRawGrammar(fs.readFileSync(file, "utf8"), file);
  },
});

// Every scope of each token whose text is `text`, in order.
async function tokens(scope, source, text) {
  const g = await registry.loadGrammar(scope);
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

async function innermost(scope, source, text) {
  return (await tokens(scope, source, text)).map((s) => s[s.length - 1]);
}

function cases(scope, list) {
  for (const [description, source, text, expected, which = -1] of list) {
    test(`${scope}: ${description}`, async () => {
      const scopes = await innermost(scope, source, text);
      assert.ok(scopes.length > 0, `no token ${JSON.stringify(text)} in ${JSON.stringify(source)}`);
      const at = which < 0 ? scopes.length - 1 : which;
      assert.strictEqual(scopes[at], expected, `${JSON.stringify(text)} in ${JSON.stringify(source)}: ${scopes}`);
    });
  }
}

cases("source.k", [
  // [description, source, token text, expected innermost scope, which occurrence]
  ["a slash at the start of a line is a comment", "/ note", "/", "punctuation.definition.comment.k"],
  ["so is one after a space", "a:1 / note", "/", "punctuation.definition.comment.k"],
  ["one after a value is over", "r:+/1 2", "/", "keyword.operator.adverb.k"],
  ["each is an adverb", "r:#'x", "'", "keyword.operator.adverb.k"],
  ["each-prior is one adverb", "r:-':x", "':", "keyword.operator.adverb.k"],
  ["each-right is one adverb", "r:x,/:y", "/:", "keyword.operator.adverb.k"],
  ["each-left is one adverb", "r:x,\\:y", "\\:", "keyword.operator.adverb.k"],
  ["scan after a value is an adverb", "r:+\\1 2", "\\", "keyword.operator.adverb.k"],
  ["a system command at the start of a line", "\\d .k", "\\d", "keyword.other.system.k"],
  ["and its namespace", "\\d .k", ".k", "entity.name.namespace.k"],
  ["a string's escape", 's:"a\\nb"', "\\n", "constant.character.escape.k"],
  ["an escape k does not define is illegal", 's:"a\\qb"', "\\q", "invalid.illegal.escape.k"],
  ["a symbol", "s:`abc", "`abc", "constant.other.symbol.k"],
  ["a file handle", "h:`:data/x", "`:data/x", "constant.other.symbol.handle.k"],
  ["a slash after a symbol's colon is in the symbol", "s:`a:b/c", "`a:b/c", "constant.other.symbol.k"],
  ["a minus ends a handle", "h:`:a-b", "`:a", "constant.other.symbol.handle.k"],
  ["a number", "n:1.5e3", "1.5e3", "constant.numeric.k"],
  ["a date", "d:2024.01.02", "2024.01.02", "constant.numeric.temporal.k"],
  ["a timestamp", "t:2024.01.02D10:00:00.5", "2024.01.02D10:00:00.5", "constant.numeric.temporal.k"],
  ["a time", "t:10:00:00.000", "10:00:00.000", "constant.numeric.temporal.k"],
  ["a typed null", "x:0Nd", "0Nd", "constant.language.null.k"],
  ["a time's fraction is any length", "t:10:00:00.1", "10:00:00.1", "constant.numeric.temporal.k"],
  ["a nanosecond time is one literal", "t:12:00:00.123456789", "12:00:00.123456789", "constant.numeric.temporal.k"],
  ["a date made a timestamp with p", "d:2024.01.02p", "2024.01.02p", "constant.numeric.temporal.k"],
  ["an upper-case exponent", "n:1.5E3", "1.5E3", "constant.numeric.k"],
  ["a boolean vector", "b:101b", "101b", "constant.language.boolean.k"],
  ["a bracket", "f[1]", "[", "punctuation.section.brackets.k"],
  ["a parameter", "f:{[a;b] a+b}", "b", "variable.parameter.k", 0],
  ["an implicit x", "f:{x+1}", "x", "variable.language.implicit.k"],
  ["an assignment", "a:1", ":", "keyword.operator.assignment.k"],
  ["a number made a timestamp with p", "t:1p", "1p", "constant.numeric.k"],
]);

test("source.k: a block comment runs from a lone / to a lone \\, and code follows", async () => {
  const src = "a:1\n/\nnot code\n\\\nb:2";
  assert.ok((await innermost("source.k", src, "not code"))[0].startsWith("comment.block.k"));
  assert.deepStrictEqual(await innermost("source.k", src, "b"), ["variable.other.k"]);
});

test("source.k: 0Ns, 0Ws and 0Wg are not nulls, since q refuses them", async () => {
  for (const text of ["0Ns", "0Ws", "0Wg"]) {
    assert.notDeepStrictEqual(await innermost("source.k", `x:${text}`, text), ["constant.language.null.k"], text);
  }
  assert.deepStrictEqual(await innermost("source.k", "x:0Ng", "0Ng"), ["constant.language.null.k"]);
});

test("source.k: x is implicit only in a lambda that declares no parameters, over however many lines", async () => {
  assert.deepStrictEqual(await innermost("source.k", "f:{[a] x+a}", "x"), ["variable.other.k"]);
  assert.deepStrictEqual(await innermost("source.k", "f:{x+1}", "x"), ["variable.language.implicit.k"]);
  assert.deepStrictEqual(await innermost("source.k", "f:{[a;\n b] a+b}", "b"), ["variable.parameter.k", "variable.other.k"]);
});

test("source.k: a lone backslash ends the script inside an open lambda too", async () => {
  // The loader reads a lone backslash line by line, whatever is open -
  // as the q grammar has it.
  const scopes = await innermost("source.k", "f:{x+\n\\\nb:2", "b:2");
  assert.ok(scopes[0] && scopes[0].startsWith("comment.block.end-of-script.k"), String(scopes[0]));
});

test("source.k: a lone backslash outside a block ends the script", async () => {
  const scopes = await innermost("source.k", "a:1\n\\\nb:2", "b:2");
  assert.ok(scopes[0].startsWith("comment.block.end-of-script.k"), scopes[0]);
});

const SPEC = [
  "/ a spec",
  "feature count",
  "    before",
  "        n::10",
  "    should return the count of its input",
  "        expect an atom to count 1",
  "            1 ~ count `a",
  "        xexpect a skipped test",
  '            "unclosed',
  "        expect after an unclosed string, q again",
  "            2 ~ count `a`b",
  "    bench",
  "        baseline",
  "            til 100",
  "        behaviour",
  "            til 1",
  "        timelimit 100",
].join("\n");

cases("source.quke", [
  ["a feature is structure", SPEC, "feature", "keyword.control.structure.quke"],
  ["and names one", SPEC, " count", "entity.name.type.feature.quke"],
  ["a should describes a behaviour", SPEC, " return the count of its input", "entity.name.function.behaviour.quke"],
  ["an expect opens a block of q", SPEC, "expect", "keyword.control.block.quke", 0],
  ["its description is prose", SPEC, " an atom to count 1", "string.unquoted.description.quke"],
  ["a skipped expect is still a keyword", SPEC, "xexpect", "keyword.control.block.quke"],
  ["a before opens q", SPEC, "before", "keyword.control.block.quke"],
  ["the q under it is q", SPEC, "count", "support.function.builtin.q", 0],
  ["a symbol in it is q's", SPEC, "`a", "constant.other.symbol.q", 0],
  ["bench and its blocks", SPEC, "baseline", "keyword.control.block.quke"],
  ["a setting", SPEC, "timelimit", "keyword.other.setting.quke"],
  ["a comment line", SPEC, "/", "punctuation.definition.comment.quke", 0],
]);

test("source.quke: the q of a block is embedded q, for the editor's q features", async () => {
  const [scopes] = await tokens("source.quke", SPEC, "til");
  assert.ok(scopes.includes("meta.embedded.block.q"), scopes.join(" "));
});

test("source.quke: an unclosed string ends with its block, and the next keyword is a keyword", async () => {
  assert.deepStrictEqual(await innermost("source.quke", SPEC, "expect"), [
    "keyword.control.block.quke",
    "keyword.control.block.quke",
  ]);
  assert.deepStrictEqual(await innermost("source.quke", SPEC, "`b"), ["constant.other.symbol.q"]);
});

test("source.quke: a q line in a block that merely starts with a keyword's word stays q", async () => {
  const scopes = await innermost("source.quke", "feature f\n    before\n        after:1", "after");
  assert.deepStrictEqual(scopes, ["variable.other.definition.q"]);
});

// What src/query.ts's render writes, and KDB-X's .Q.S and .Q.sbt text.
const OUT = [
  "# rdb-dev (12 ms)",
  "q) select from t where px>1",
  "sym px   d          s    ts                           ",
  "------------------------------------------------------",
  'a   1.5  2024.01.02 "a\\"b" 2026.11.20D14:32:25.943726000',
  "sym px  | d          k",
  "--------| -------------",
  "b   2.25| 2024.01.03 -2",
  "a| `x`y",
  "101b 0Nd 0x1f",
  "# hdb (3 ms) - 'type",
  "'type",
  "  [2]  /tmp/lib.q:1: g:{[x] x+`a}",
  "                           ^",
  "  [0]  f 1",
  "       ^",
  "# rdb-prod - failed: connection refused",
  "# rdb-uat - timed out after 5 s: the connection closed before the process answered",
  "`a:b/c",
].join("\n");

cases("source.q-console", [
  ["the header's #", OUT, "#", "punctuation.definition.heading.q-console", 0],
  ["the header is a heading, dividing one answer from the next", OUT, " (", "markup.heading.query.q-console", 0],
  ["the process it ran on", OUT, "rdb-dev", "entity.name.tag.process.q-console"],
  ["the time it took", OUT, "12", "constant.numeric.time.q-console"],
  ["in ms", OUT, "ms", "keyword.other.unit.q-console", 0],
  ["a failure's error in the header", OUT, "'type", "invalid.illegal.error.q-console", 0],
  ["and on its own line", OUT, "'type", "invalid.illegal.error.q-console", 1],
  ["a query that never answered", OUT, "failed: connection refused", "invalid.illegal.error.q-console"],
  // As live.ts writes a query q-lint.query.timeout stopped.
  ["a query that timed out", OUT, "timed out after 5 s: the connection closed before the process answered", "invalid.illegal.error.q-console"],
  ["and its process", OUT, "rdb-uat", "entity.name.tag.process.q-console"],
  // As q prints it: past a colon a symbol takes slashes.
  ["a symbol with a slash past its colon", OUT, "`a:b/c", "constant.other.symbol.q-console"],
  ["the prompt of an included query", OUT, "q)", "punctuation.separator.prompt.q-console"],
  ["the query is q", OUT, "select", "keyword.other.qsql.q"],
  ["a table's rule", OUT, "------------------------------------------------------", "comment.line.separator.q-console"],
  ["a keyed table's rule and its bar", OUT, "|", "keyword.other.key.q-console", 0],
  ["the bar of a keyed row", OUT, "|", "keyword.other.key.q-console", 1],
  ["a number", OUT, "2.25", "constant.numeric.q-console"],
  ["a negative number", OUT, "-2", "constant.numeric.q-console"],
  ["a date", OUT, "2024.01.03", "constant.numeric.temporal.q-console"],
  ["a timestamp", OUT, "2026.11.20D14:32:25.943726000", "constant.numeric.temporal.q-console"],
  ["a string", OUT, "\"a", "string.quoted.double.q-console"],
  ["and its escape", OUT, '\\"', "constant.character.escape.q-console"],
  ["symbols", OUT, "`x", "constant.other.symbol.q-console"],
  ["a boolean vector", OUT, "101b", "constant.language.boolean.q-console"],
  ["a null", OUT, "0Nd", "constant.language.null.q-console"],
  ["a frame's number", OUT, "[2]", "keyword.control.frame.q-console"],
  ["where it is", OUT, "/tmp/lib.q:1:", "entity.name.type.location.q-console"],
  ["its code is q", OUT, "`a", "constant.other.symbol.q", 0],
  ["the caret", OUT, "^", "invalid.illegal.caret.q-console", 0],
]);

// A string cell as .Q.S prints it: the escapes q takes (#1972), so a slash
// is one and \\400 is not.
test("source.q-console: a printed string's escapes are the ones q takes", async () => {
  const printed = 's\n---------\n"a\\/b\\377c\\400"';
  assert.deepStrictEqual(await innermost("source.q-console", printed, "\\/"), ["constant.character.escape.q-console"]);
  assert.deepStrictEqual(await innermost("source.q-console", printed, "\\377"), ["constant.character.escape.q-console"]);
  assert.deepStrictEqual(await innermost("source.q-console", printed, "\\400"), []);
});

// As KDB-X's .Q.S prints them: `$"a-b" is `a-b, and a list of them
// `a-b`c, so a minus is in a printed symbol, and the next backtick starts
// the next one. A blank cannot be told from a table's column gap (a row
// `x   1 prints the same as the symbol `$"x   1"), so it ends one.
test("source.q-console: a printed symbol takes a minus (#2307)", async () => {
  for (const [printed, symbols] of [["`a-b", ["`a-b"]], ["`a-b`c", ["`a-b", "`c"]], ["a| `EUR-USD`x", ["`EUR-USD", "`x"]], ["`a:b-c/d", ["`a:b-c/d"]]]) {
    const g = await registry.loadGrammar("source.q-console");
    const { tokens: line } = g.tokenizeLine(printed, tm.INITIAL);
    const found = line.filter((t) => t.scopes.includes("constant.other.symbol.q-console")).map((t) => printed.slice(t.startIndex, t.endIndex));
    assert.deepStrictEqual(found.join("").match(/`[^`]*/g), symbols, printed);
  }
  // A key column's bar is still the key's.
  assert.deepStrictEqual(await innermost("source.q-console", "`a-b| 1", "|"), ["keyword.other.key.q-console"]);
});

test("source.q-console: a guid is one value, not hex with numbers in it", async () => {
  // As .Q.S prints a guid column: 1?0Ng and the null guid.
  for (const guid of ["8c6b8b64-6815-6084-0a3e-178401251b68", "00000000-0000-0000-0000-000000000000"]) {
    assert.deepStrictEqual(await innermost("source.q-console", `g\n----\n${guid}`, guid), ["constant.other.guid.q-console"], guid);
  }
});

test("source.q-console: a table's column names are left plain", async () => {
  const g = await registry.loadGrammar("source.q-console");
  const { tokens: line } = g.tokenizeLine(OUT.split("\n")[2], tm.INITIAL);
  assert.deepStrictEqual([...new Set(line.flatMap((t) => t.scopes))], ["source.q-console"]);
});

test("the k, quke and q-console languages and their grammars are declared", () => {
  const langs = Object.fromEntries(pkg.contributes.languages.map((l) => [l.id, l]));
  assert.deepStrictEqual(langs.k.extensions, [".k"]);
  assert.ok(langs.k.aliases.includes("k"));
  assert.deepStrictEqual(langs.quke.extensions, [".quke"]);
  // The console is a channel's language, never a file's, and not offered in
  // the language picker.
  assert.strictEqual(langs["q-console"].extensions, undefined);
  assert.deepStrictEqual(langs["q-console"].aliases, []);
  for (const id of ["k", "quke"]) {
    const config = path.join(root, langs[id].configuration);
    const { comments, brackets } = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.strictEqual(comments.lineComment, "/", id);
    assert.ok(brackets.length >= 3, id);
  }
  const grammars = Object.fromEntries(pkg.contributes.grammars.map((g) => [g.language, g]));
  for (const [id, scope] of [["k", "source.k"], ["quke", "source.quke"], ["q-console", "source.q-console"]]) {
    assert.strictEqual(grammars[id].scopeName, scope);
    assert.strictEqual(grammars[id].path, `./syntaxes/${files[scope]}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, grammars[id].path), "utf8")).scopeName, scope);
  }
  assert.deepStrictEqual(grammars.quke.embeddedLanguages, { "meta.embedded.block.q": "q" });
});

test("q-console claims no output channel but its own", () => {
  // VS Code gives a channel created without a language the language that
  // last registered the mimetype text/x-code-output - an extension's beats
  // the built-in one - so claiming it would colour every other extension's
  // output, and q-lint's own server log, as q console text. The query
  // channel names its language itself.
  for (const lang of pkg.contributes.languages) {
    assert.ok(!(lang.mimetypes ?? []).includes("text/x-code-output"), lang.id);
  }
});

test("the query channel is created with the q-console language", () => {
  const live = fs.readFileSync(path.join(root, "src", "live.ts"), "utf8");
  assert.match(live, /createOutputChannel\("q-lint: query", "q-console"\)/);
});

test("only saved .q files are linted: not k, quke or the console", () => {
  assert.deepStrictEqual(LINTED, [{ scheme: "file", language: "q", pattern: "**/*.q" }]);
  for (const id of ["k", "quke", "q-console"]) {
    assert.ok(!LINTED.some((s) => s.language === id), id);
  }
  const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
  assert.match(extension, /documentSelector: LINTED,/);
  // Nor does opening one start the server.
  for (const id of ["k", "quke", "q-console"]) {
    assert.ok(!pkg.activationEvents.includes(`onLanguage:${id}`), id);
  }
});
