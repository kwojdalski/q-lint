// Function diff's q against a real process (#1045): a lambda's definition as
// written, a projection as q shows it, every function directly in a
// namespace, a name that is not there, and one that is neither. Needs
// QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { FUNCTION_TEXTS, compareTexts, readTexts, sideDocument } = require("../out/fndiff.js");

const SERVER = [".lib.f:{x+1}", ".lib.g:{[a;b]", "  a*b}", ".lib.p:{x+y}[1]", ".lib.v:3", ".lib.sub.h:{x}", "top:{x-1}", ""].join("\n");

test("definitions are answered as written, a namespace's every function", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER);
  const read = async (name) => readTexts(await connection.call(FUNCTION_TEXTS, name));
  assert.deepStrictEqual(await read(".lib.f"), { kind: "function", texts: new Map([[".lib.f", "{x+1}"]]), held: new Map() });
  assert.deepStrictEqual(await read("top"), { kind: "function", texts: new Map([["top", "{x-1}"]]), held: new Map() });
  const ns = await read(".lib");
  assert.strictEqual(ns.kind, "namespace");
  assert.deepStrictEqual([...ns.texts.keys()], [".lib.f", ".lib.g", ".lib.p"]);
  assert.strictEqual(ns.texts.get(".lib.g"), "{[a;b]\n  a*b}");
  assert.strictEqual(ns.texts.get(".lib.p"), "{x+y}[1]");
  assert.deepStrictEqual([...(await read(".lib.sub")).texts.keys()], [".lib.sub.h"]);
  assert.strictEqual((await read(".nope")).kind, "missing");
  assert.strictEqual((await read(".lib.v")).kind, "other");
});

// A view is not a function, and asking does not evaluate it (#1865).
test("a view is answered as neither a function nor a namespace, and is not evaluated (#1865)", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER + "t:([] a:1 2)\nspy::select from t\nbad::1+`a\n");
  const pending = () => connection.call('{[x] string system"B"}', 0);
  for (const name of ["spy", "bad"]) {
    assert.strictEqual(readTexts(await connection.call(FUNCTION_TEXTS, name)).kind, "other");
  }
  assert.deepStrictEqual(await pending(), ["bad", "spy"]);
});

test("a projection's text is whole, whatever the process's \\c (#1870)", { skip }, async (t) => {
  const { connection } = await connect(t, "\\c 25 40\n.lib.f:{x+1}\n.lib.p:{x+y}[til 60]\ntop:{x+y+z}[`aVeryLongSymbolIndeed;;\"and a string that goes on past the width\"]\n");
  const read = async (name) => readTexts(await connection.call(FUNCTION_TEXTS, name));
  const p = `{x+y}[${Array.from({ length: 60 }, (_, i) => i).join(" ")}]`;
  assert.deepStrictEqual([...(await read(".lib")).texts], [[".lib.f", "{x+1}"], [".lib.p", p]]);
  assert.strictEqual((await read("top")).texts.get("top"), '{x+y+z}[`aVeryLongSymbolIndeed;;"and a string that goes on past the width"]');
  assert.deepStrictEqual(Array.from((await connection.evaluate("system\"c\"")).value, Number), [25, 40]);
});

// A name one process holds as a table read "is not defined" on that side of
// the diff: it is defined there, as data, and that is the difference.
test("a name that is not a function is answered with what it holds, and its side says so (#2984)", { skip }, async (t) => {
  const a = await connect(t, "cfg:{x+1}\n.lib.f:{x}\n.lib.h:{x}\n");
  const b = await connect(t, "cfg:([]k:`a`b;v:1 2)\n.lib.f:{x}\n.lib.h:`a`b!1 2\n.lib.sub.g:{x}\nkt:([k:`a`b]v:1 2)\nn:42\nl:1 2 3f\nvw::n+1\n");
  const read = async (c, name) => readTexts(await c.connection.call(FUNCTION_TEXTS, name));
  const [ta, tb] = [await read(a, "cfg"), await read(b, "cfg")];
  assert.deepStrictEqual(compareTexts(ta.texts, tb.texts), [{ name: "cfg", status: "only in first" }]);
  assert.deepStrictEqual([tb.kind, [...tb.held]], ["other", [["cfg", "a table"]]]);
  assert.strictEqual(sideDocument("cfg", "B", tb.texts.get("cfg"), tb.held.get("cfg")), "/ cfg is a table on B, not a function\n");
  assert.strictEqual(sideDocument("cfg", "A", ta.texts.get("cfg"), ta.held.get("cfg")), "{x+1}\n");
  for (const [name, what] of [["kt", "a keyed table"], ["n", "an atom of type -7h"], ["l", "a list of type 9h"], [".lib.h", "a dictionary"], ["vw", "a view"]]) {
    assert.deepStrictEqual([...(await read(b, name)).held], [[name, what]], name);
  }
  // In a namespace too: what is not a function there is told, not missing.
  const ns = await read(b, ".lib");
  assert.deepStrictEqual([...ns.texts.keys()], [".lib.f"]);
  assert.deepStrictEqual([...ns.held], [[".lib", "a namespace"], [".lib.h", "a dictionary"], [".lib.sub", "a namespace"]]);
  assert.strictEqual(sideDocument(".lib.h", "B", ns.texts.get(".lib.h"), ns.held.get(".lib.h")), "/ .lib.h is a dictionary on B, not a function\n");
  // A name the process does not hold is still not defined there.
  const none = await read(b, "nope");
  assert.strictEqual(sideDocument("nope", "B", none.texts.get("nope"), none.held.get("nope")), "/ nope is not defined on B\n");
  assert.deepStrictEqual((await b.connection.evaluate('string system"B"')).value, ["vw"]);
});
