// Query placeholders (#911): where `{{name}}` stands, the code once each is
// given a value, the values remembered, and the boxes the user is asked in.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const {
  PLACEHOLDER_VALUES_KEY,
  REMEMBERED_LIMIT,
  lastValue,
  placeholderNames,
  placeholders,
  readPlaceholders,
  remembered,
  substitute,
} = require("../out/placeholders.js");
const { Live } = require("../out/live.js");

test("a placeholder is a q name in double braces, spaces allowed inside", () => {
  assert.deepStrictEqual(placeholderNames("select from t where date={{day}}, sym={{ sym }}"), ["day", "sym"]);
  assert.deepStrictEqual(placeholderNames("{{.ns.v}}+{{start_date}}+{{a1}}"), [".ns.v", "start_date", "a1"]);
  assert.deepStrictEqual(placeholderNames("{{a}}+{{a}}"), ["a"]);
  // Not names: empty, a number first, an expression.
  assert.deepStrictEqual(placeholderNames("{{}} {{1a}} {{a+b}} {{_a}} { {a} }"), []);
});

test("x, y and z are lambdas, never placeholders", () => {
  assert.deepStrictEqual(placeholderNames("f:{{x}}; g:{{y}} ; h:{{ z }}"), []);
  assert.deepStrictEqual(placeholderNames("{{x}} {{n}}"), ["n"]);
});

test("nothing in a string or a comment is a placeholder", () => {
  assert.deepStrictEqual(placeholderNames('s:"{{a}}"; t:{{b}}'), ["b"]);
  assert.deepStrictEqual(placeholderNames('s:"a\\"{{a}}"; {{b}}'), ["b"]);
  assert.deepStrictEqual(placeholderNames("a:{{b}} / {{c}}\n/ {{d}}\n{{e}}"), ["b", "e"]);
  assert.deepStrictEqual(placeholderNames("/\n{{inblock}}\n\\\n{{after}}"), ["after"]);
  // A slash that is not after a space is q's over, not a comment.
  assert.deepStrictEqual(placeholderNames("+/{{v}}"), ["v"]);
  assert.deepStrictEqual(placeholderNames("a:1\r\n{{crlf}}"), ["crlf"]);
});

test("each placeholder is replaced by its value as written; one with none is left", () => {
  assert.strictEqual(substitute("select from t where sym={{s}}, d={{ d }}", { s: "`AAPL", d: "2024.01.01" }), "select from t where sym=`AAPL, d=2024.01.01");
  assert.strictEqual(substitute('{{a}}+{{a}},"{{a}}",{{b}}', { a: "1" }), '1+1,"{{a}}",{{b}}');
  // A value holding `$&` or braces is put in as written.
  assert.strictEqual(substitute("{{a}}", { a: "$&{{b}}" }), "$&{{b}}");
  const code = "x:{{n}}\ny:2";
  const [p] = placeholders(code);
  assert.deepStrictEqual([p.name, code.slice(p.start, p.end)], ["n", "{{n}}"]);
});

test("values are remembered newest last, at most REMEMBERED_LIMIT, and read back", () => {
  const once = remembered(undefined, { a: "1", b: "2" });
  assert.deepStrictEqual(once, { a: "1", b: "2" });
  assert.deepStrictEqual(Object.keys(remembered(once, { a: "3" })), ["b", "a"]);
  assert.strictEqual(lastValue(remembered(once, { a: "3" }), "a"), "3");
  assert.strictEqual(lastValue({ a: 1 }, "a"), undefined);
  assert.strictEqual(lastValue(undefined, "a"), undefined);
  assert.strictEqual(lastValue({}, "constructor"), undefined);
  const many = Object.fromEntries(Array.from({ length: REMEMBERED_LIMIT + 5 }, (_, i) => [`n${i}`, String(i)]));
  const kept = remembered({ junk: 5, ...many }, { last: "x" });
  assert.strictEqual(Object.keys(kept).length, REMEMBERED_LIMIT);
  assert.strictEqual(Object.keys(kept).at(-1), "last");
  assert.ok(!("n0" in kept));
  assert.strictEqual(Object.getPrototypeOf(remembered({}, { __proto__x: "1", ["__proto__"]: "2" })), Object.prototype);
});

test("placeholders are on unless the setting is false", () => {
  assert.deepStrictEqual(readPlaceholders((k, f) => f), { enabled: true });
  assert.deepStrictEqual(readPlaceholders((k, f) => (k === "query.placeholders.enable" ? false : f)), { enabled: false });
  assert.deepStrictEqual(readPlaceholders((k, f) => (k === "query.placeholders.enable" ? "no" : f)), { enabled: true });
});

/// A Live over a fresh context, and the code Query Current Line sent.
function setUp(t, text) {
  stub.reset();
  const context = stub.newContext();
  const live = new Live(context);
  const sent = [];
  live.run = async (code) => void sent.push(code);
  const vscode = require("vscode");
  vscode.window.activeTextEditor = {
    document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text }), getText: () => text },
    selection: { active: { line: 0 }, isEmpty: true },
  };
  t.after(() => {
    vscode.window.activeTextEditor = undefined;
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { context, live, sent, query: () => stub.commands.get("q-lint.queryCurrentLine")() };
}

test("a query asks for each placeholder, starting from the value given last, and Escape runs nothing", async (t) => {
  const { context, sent, query } = setUp(t, "select from t where sym={{sym}}, n<{{n}}, m>{{n}}");
  const asked = [];
  stub.inputs.push((o) => (asked.push([o.title, o.value]), "`a"), (o) => (asked.push([o.title, o.value]), "10"));
  await query();
  assert.deepStrictEqual(sent, ["select from t where sym=`a, n<10, m>10"]);
  assert.deepStrictEqual(asked, [["q-lint: {{sym}} (1 of 2)", ""], ["q-lint: {{n}} (2 of 2)", ""]]);
  assert.deepStrictEqual(context.globalState.get(PLACEHOLDER_VALUES_KEY), { sym: "`a", n: "10" });
  // Again: each box starts from the last value; Escape on the second runs nothing.
  stub.inputs.push((o) => (asked.push([o.title, o.value]), "`b"), undefined);
  await query();
  assert.deepStrictEqual(sent.length, 1);
  assert.deepStrictEqual(asked.slice(2), [["q-lint: {{sym}} (1 of 2)", "`a"]]);
  assert.deepStrictEqual(context.globalState.get(PLACEHOLDER_VALUES_KEY), { sym: "`a", n: "10" });
});

test("with placeholders off, or none in the code, nothing is asked", async (t) => {
  const { sent, query } = setUp(t, "f:{{x}}; {{a}}");
  stub.config.user["query.placeholders.enable"] = false;
  await query();
  stub.config.user["query.placeholders.enable"] = true;
  stub.inputs.push("1");
  await query();
  assert.deepStrictEqual(sent, ["f:{{x}}; {{a}}", "f:{{x}}; 1"]);
});

test("nothing after a lone \\, the script's end, is a placeholder (#1471)", () => {
  assert.deepStrictEqual(placeholderNames("select from t where d={{day}}\n\\\nold scratch {{when}}"), ["day"]);
  // A \ that closes a block comment ends nothing.
  assert.deepStrictEqual(placeholderNames("/\n{{a}}\n\\\n{{b}}"), ["b"]);
  const { tileQueryProblem } = require("../out/dashboard.js");
  assert.strictEqual(tileQueryProblem("select from t\n\\\nscratch: {{x1}}"), undefined);
});
