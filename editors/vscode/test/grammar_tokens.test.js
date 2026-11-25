// The q and k grammars and the dotted-names word pattern against q's own
// tokens, saved in grammar_tokens.json by grammar_tokens_q.test.js: every
// token of every line is coloured as the class q reads it in (a refused
// number is no number, and no piece of one is), every generated literal q
// takes is one literal and every one it refuses has no colour, and every name
// or number is one word. Corpus-like lines, seeded random statements and
// generated literals (grammar_tokens_inputs.js), so the classes of #2298 to
// #2306 cannot come back unseen.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const tm = require("vscode-textmate");
const og = require("vscode-oniguruma");
const { lines, literals } = require("./grammar_tokens_inputs.js");
const { WORD } = require("../out/editing.js");

const saved = JSON.parse(fs.readFileSync(path.join(__dirname, "grammar_tokens.json"), "utf8"));
const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
const onig = og.loadWASM(wasm).then(() => ({
  createOnigScanner: (p) => new og.OnigScanner(p),
  createOnigString: (s) => new og.OnigString(s),
}));
const registry = new tm.Registry({
  onigLib: onig,
  loadGrammar: async (scope) => {
    const file = { "source.q": "q", "source.k": "k" }[scope];
    if (file === undefined) return null;
    const at = path.join(__dirname, "..", "syntaxes", `${file}.tmLanguage.json`);
    return tm.parseRawGrammar(fs.readFileSync(at, "utf8"), at);
  },
});

/// The tokens q read `line` as, `[text, class]`, from the saved row; none for
/// a line q refused to tokenize.
function tokensOf(line, row) {
  if (row === "") return null;
  let at = 0;
  const tokens = row.split(" ").map((item) => {
    const n = parseInt(item, 10);
    return [line.slice(at, (at += n)), item.slice(String(n).length)];
  });
  assert.strictEqual(tokens.map((t) => t[0]).join(""), line);
  return tokens;
}

/// The class a grammar's scopes give a character, in q's letters.
function classOf(scopes) {
  const s = scopes.join(" ");
  if (/\bcomment\./.test(s)) return "C";
  if (/string\.quoted/.test(s)) return "S";
  if (/constant\.other\.symbol/.test(s)) return "Y";
  if (/constant\.(numeric|language)/.test(s)) return "N";
  return "O";
}

test("the saved lines and literals are the inputs' (else regenerate them with grammar_tokens_q.test.js)", () => {
  assert.deepStrictEqual(saved.lines.map((l) => l[0]), lines());
  assert.deepStrictEqual(saved.literals.map((l) => l[0]), literals());
  assert.ok(saved.lines.filter((l) => l[1] !== "").length >= 500);
});

for (const language of ["q", "k"]) {
  test(`${language}: every token of a line is coloured as q reads it`, async () => {
    const g = await registry.loadGrammar(`source.${language}`);
    const wrong = [];
    for (const [line, row] of saved.lines) {
      const tokens = tokensOf(line, row);
      if (tokens === null) continue;
      const classes = new Array(line.length).fill("O");
      for (const t of g.tokenizeLine(line, tm.INITIAL).tokens) classes.fill(classOf(t.scopes), t.startIndex, t.endIndex);
      let at = 0;
      for (const [text, q] of tokens) {
        // A file verb's colon is the operator's; a number's sign is not its colour.
        const seen = new Set([...text].map((ch, i) => (/\s/.test(ch) || (i === 0 && /^-[\d.]/.test(text)) ? null : classes[at + i])).filter((c) => c !== null));
        if (q !== "X" && [...seen].some((c) => c !== q)) wrong.push(`${JSON.stringify(text)} is ${q} to q, ${[...seen].join("")} in ${line}`);
        at += text.length;
      }
    }
    assert.deepStrictEqual(wrong, []);
  });

  test(`${language}: a generated literal is coloured whole when q takes it, and not at all when q refuses it`, async () => {
    const g = await registry.loadGrammar(`source.${language}`);
    const wrong = [];
    for (const [literal, verdict] of saved.literals) {
      if (verdict === "split" || verdict === "junk") continue;
      const tokens = g.tokenizeLine(`a:${literal}`, tm.INITIAL).tokens.filter((t) => t.startIndex >= 2);
      const coloured = tokens.filter((t) => t.scopes.some((s) => /^constant\./.test(s)));
      const got = coloured.length === 0 ? "no" : tokens.length === 1 && coloured.length === 1 ? "lit" : "part";
      if (got !== verdict) wrong.push(`${literal}: q ${verdict}, grammar ${got}`);
    }
    assert.deepStrictEqual(wrong, []);
  });
}

test("every name and every number q reads is one word, and a file verb's digit is its own", () => {
  const wrong = [];
  for (const [line, row] of saved.lines) {
    const tokens = tokensOf(line, row);
    if (tokens === null) continue;
    const words = [...line.matchAll(new RegExp(WORD.source, "g"))].map((m) => [m.index, m[0]]);
    let at = 0;
    for (const [text, q] of tokens) {
      const sign = /^-[\d.]/.test(text) ? 1 : 0;
      const want = q === "X" ? text[0] : q === "N" || (q === "O" && /^\.?[A-Za-z]/.test(text)) ? text.slice(sign) : null;
      if (want !== null && !/\s/.test(want)) {
        const word = words.find(([from]) => from === at + sign);
        if (word?.[1] !== want) wrong.push(`${JSON.stringify(want)} is ${JSON.stringify(word?.[1] ?? null)} in ${line}`);
      }
      at += text.length;
    }
  }
  assert.deepStrictEqual(wrong, []);
});
