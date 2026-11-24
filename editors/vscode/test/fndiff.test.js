// Function diff between two processes (#1045): definitions read and
// compared - and, through the stand-in `vscode` and two fake q processes:
// off, the commands refuse and nothing is sent; on, each process is read
// over a connection of its own with the one read-only lambda, VS Code's diff
// is opened on the two definitions, and a namespace lists what differs. The
// q side is fndiff_q.test.js.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp, fakeQ, heads } = require("./fakeq.js");
const { FUNCTION_TEXTS, compareTexts, nameProblem, readTexts, sideDocument } = require("../out/fndiff.js");
const { registerFunctionDiff } = require("../out/fndiffview.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const pkg = require("../package.json");

test("an answer is read, one function as strings, and two sides compared", () => {
  assert.deepStrictEqual([...readTexts(["function", ".lib.f", "{x+1}"]).texts], [[".lib.f", "{x+1}"]]);
  assert.deepStrictEqual([...readTexts(["namespace", [".lib.f", ".lib.g"], ["{x}", "{y}"]]).texts.keys()], [".lib.f", ".lib.g"]);
  assert.strictEqual(readTexts(["missing", [], []]).kind, "missing");
  assert.throws(() => readTexts(["what", [], []]), /definitions/);
  const a = new Map([[".l.f", "{x}"], [".l.g", "{y}"], [".l.h", "{z}"]]);
  const b = new Map([[".l.f", "{x}"], [".l.g", "{y+1}"], [".l.k", "{k}"]]);
  assert.deepStrictEqual(compareTexts(a, b), [
    { name: ".l.g", status: "differs" },
    { name: ".l.h", status: "only in first" },
    { name: ".l.k", status: "only in second" },
    { name: ".l.f", status: "same" },
  ]);
  // Trailing blanks on a line are not a difference (#1379).
  assert.deepStrictEqual(compareTexts(new Map([[".l.f", "{x+1 \n }"]]), new Map([[".l.f", "{x+1\n }"]])), [{ name: ".l.f", status: "same" }]);
  assert.strictEqual(sideDocument(".l.f", "rdb", undefined), "/ .l.f is not defined on rdb\n");
  assert.strictEqual(sideDocument(".l.f", "rdb", "{x}"), "{x}\n");
  assert.strictEqual(nameProblem(".lib.f"), undefined);
  assert.strictEqual(nameProblem("f"), undefined);
  assert.match(nameProblem("1+1"), /a q name/);
});

test("the switch is declared on, and the commands only where they can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.processes.functionDiff.enable"].default, true);
  for (const id of [PROCESS_TOOL_COMMANDS.diffFunction, PROCESS_TOOL_COMMANDS.diffNamespace]) {
    const entries = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === id);
    assert.ok(entries.length > 0);
    assert.ok(entries.every((m) => /config\.q-lint\.processes\.functionDiff\.enable/.test(m.when)));
  }
});

const side = (texts) => (m) => {
  if (!Array.isArray(m) || m[0] !== FUNCTION_TEXTS) return null;
  const t = texts[m[1]];
  return t === undefined ? ["missing", [], []] : t;
};

test("off, nothing is sent; on, each process is read apart and the diff opened", async (t) => {
  const other = await fakeQ(side({ ".lib.f": ["function", [".lib.f"], ["{x+2}"]], ".lib": ["namespace", [".lib.f", ".lib.g"], ["{x+2}", "{y}"]] }));
  t.after(() => other.close());
  const { q, feature } = await setUp(t, {
    config: { "processes.functionDiff.enable": false },
    answer: side({ ".lib.f": ["function", [".lib.f"], ["{x+1}"]], ".lib": ["namespace", [".lib.f", ".lib.g", ".lib.h"], ["{x+1}", "{y}", "{z}"]] }),
    register: registerFunctionDiff,
    more: [{ label: "hdb", port: other.port }],
  });
  const diffs = [];
  stub.commands.set("vscode.diff", (a, b, title) => void diffs.push({ a: a.toString(), b: b.toString(), title }));
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.diffFunction)(".lib.f", "rdb", "hdb"), /Function diff between processes is turned off/);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.diffNamespace)(".lib", "rdb", "hdb"), /turned off/);
  assert.strictEqual(q.sent.length + other.sent.length, 0);

  stub.config.user["processes.functionDiff.enable"] = true;
  stub.changeConfig("q-lint.processes.functionDiff.enable");
  const state = await stub.commands.get(PROCESS_TOOL_COMMANDS.diffFunction)(".lib.f", "rdb", "hdb");
  assert.deepStrictEqual(state.differences, [{ name: ".lib.f", status: "differs" }]);
  assert.deepStrictEqual(heads(q.sent), [FUNCTION_TEXTS]);
  assert.deepStrictEqual(other.sent, [[FUNCTION_TEXTS, ".lib.f"]]);
  assert.strictEqual(diffs.length, 1);
  assert.match(diffs[0].title, /\.lib\.f: rdb vs hdb/);

  // A namespace: what differs is offered; the one picked opens.
  stub.picks.push((options) => options.items.find((i) => i.name === ".lib.h"));
  const ns = await stub.commands.get(PROCESS_TOOL_COMMANDS.diffNamespace)(".lib", "rdb", "hdb");
  assert.deepStrictEqual(ns.differences.map((d) => d.status), ["differs", "only in first", "same"]);
  assert.strictEqual(diffs.length, 2);
  assert.match(diffs[1].title, /\.lib\.h/);

  // The same process twice is refused before anything is read.
  const sent = q.sent.length;
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.diffFunction)(".lib.f", "rdb", "rdb"), /chosen twice/);
  assert.strictEqual(q.sent.length, sent);
  // Neither side has it.
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.diffFunction)(".nope.f", "rdb", "hdb"), /neither a function nor a namespace/);
  assert.ok(feature.last());
});
