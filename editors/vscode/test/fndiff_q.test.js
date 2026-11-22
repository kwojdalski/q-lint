// Function diff's q against a real process (#1045): a lambda's definition as
// written, a projection as q shows it, every function directly in a
// namespace, a name that is not there, and one that is neither. Needs
// QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { FUNCTION_TEXTS, readTexts } = require("../out/fndiff.js");

const SERVER = [".lib.f:{x+1}", ".lib.g:{[a;b]", "  a*b}", ".lib.p:{x+y}[1]", ".lib.v:3", ".lib.sub.h:{x}", "top:{x-1}", ""].join("\n");

test("definitions are answered as written, a namespace's every function", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER);
  const read = async (name) => readTexts(await connection.call(FUNCTION_TEXTS, name));
  assert.deepStrictEqual(await read(".lib.f"), { kind: "function", texts: new Map([[".lib.f", "{x+1}"]]) });
  assert.deepStrictEqual(await read("top"), { kind: "function", texts: new Map([["top", "{x-1}"]]) });
  const ns = await read(".lib");
  assert.strictEqual(ns.kind, "namespace");
  assert.deepStrictEqual([...ns.texts.keys()], [".lib.f", ".lib.g", ".lib.p"]);
  assert.strictEqual(ns.texts.get(".lib.g"), "{[a;b]\n  a*b}");
  assert.strictEqual(ns.texts.get(".lib.p"), "{x+y}[1]");
  assert.deepStrictEqual([...(await read(".lib.sub")).texts.keys()], [".lib.sub.h"]);
  assert.strictEqual((await read(".nope")).kind, "missing");
  assert.strictEqual((await read(".lib.v")).kind, "other");
});
