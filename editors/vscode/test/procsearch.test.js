// Find in processes (#1046): hits read and grouped, the tree built - and,
// through the stand-in `vscode` and two fake q processes: off, the view is
// gone and nothing is sent; on, every process with the tag is searched
// apart with the one read-only lambda, a failed one shown as failed, and a
// hit opens the live source read again from its process. The q side is
// procsearch_q.test.js.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp, fakeQ } = require("./fakeq.js");
const { SEARCH, SEARCH_LIMIT, groupHits, patternProblem, readFound } = require("../out/procsearch.js");
const { FUNCTION_TEXTS } = require("../out/fndiff.js");
const { registerFindInProcesses, foundTree, FIND_VIEW } = require("../out/procsearchview.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const pkg = require("../package.json");

const RAW = [[".lib.f", ".lib.f", "top", "tradeCount"], ["function", "function", "function", "variable"], [1, 3, 1, 0], ["{[x]", "  t:trade;", "{count trade}", ""], 12, false];

test("hits are read, one as atoms, and grouped by name", () => {
  const found = readFound(RAW);
  assert.strictEqual(found.hits.length, 4);
  assert.deepStrictEqual(found.hits[1], { name: ".lib.f", kind: "function", line: 3, text: "  t:trade;" });
  assert.deepStrictEqual(readFound(["top", "function", 1, "{count trade}", 3, true]).hits, [{ name: "top", kind: "function", line: 1, text: "{count trade}" }]);
  assert.deepStrictEqual(readFound([[], [], [], [], 0, false]).hits, []);
  assert.throws(() => readFound([["a"], ["thing"], [1], ["x"], 1, false]), /search hits/);
  assert.deepStrictEqual(groupHits(found.hits).map((g) => [g.name, g.hits.length]), [
    [".lib.f", 2],
    ["top", 1],
    ["tradeCount", 1],
  ]);
  assert.match(patternProblem("  "), /type something/);
  assert.strictEqual(patternProblem("trade"), undefined);
});

test("the tree has each process, its functions, their lines, and a failure as one", () => {
  const tree = foundTree([{ process: "rdb", found: readFound(RAW) }, { process: "hdb", error: "connection refused" }], "trade");
  assert.strictEqual(tree[0].description, "4 hits in 12 functions");
  const f = tree[0].children[0];
  assert.strictEqual(f.label, ".lib.f");
  assert.deepStrictEqual(f.children.map((c) => [c.label, c.description]), [
    ["{[x]", "line 1"],
    ["t:trade;", "line 3"],
  ]);
  assert.deepStrictEqual(f.children[1].command.arguments, [{ process: "rdb", name: ".lib.f", line: 3 }]);
  assert.strictEqual(tree[0].children[2].description, "variable");
  assert.match(tree[1].description, /failed: connection refused/);
});

test("the switch is declared on, and the view and its commands only where it is", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.processes.findInProcesses.enable"].default, true);
  assert.strictEqual(pkg.contributes.views["q-lint"].find((v) => v.id === FIND_VIEW).when, "config.q-lint.processes.findInProcesses.enable");
  const entries = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === PROCESS_TOOL_COMMANDS.findInProcesses);
  assert.ok(entries.length >= 3 && entries.every((m) => /config\.q-lint\.processes\.findInProcesses\.enable/.test(m.when)));
});

const answer = (m) => (!Array.isArray(m) ? null : m[0] === SEARCH ? RAW : m[0] === FUNCTION_TEXTS ? ["function", [m[1]], ["{[x]\n  y:1;\n  t:trade;\n  t}"]] : null);

test("off, nothing is sent; on, every tagged process is searched apart and a hit opens", async (t) => {
  const down = await fakeQ(null);
  down.close();
  const other = await fakeQ(answer);
  t.after(() => other.close());
  const { q, feature } = await setUp(t, {
    tags: ["eu"],
    config: { "processes.findInProcesses.enable": false },
    answer,
    register: registerFindInProcesses,
    more: [
      { label: "hdb", port: other.port, tags: ["eu"] },
      { label: "gone", port: down.port, tags: ["eu"] },
      { label: "us", port: other.port, tags: ["us"] },
    ],
  });
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.findInProcesses)("eu", "trade", false), /Find in processes is turned off/);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.openFoundSource)({ process: "rdb", name: ".lib.f", line: 3 }), /turned off/);
  assert.strictEqual(q.sent.length + other.sent.length, 0);
  assert.strictEqual(feature.tree().open, false);

  stub.config.user["processes.findInProcesses.enable"] = true;
  stub.changeConfig("q-lint.processes.findInProcesses.enable");
  const outcomes = await stub.commands.get(PROCESS_TOOL_COMMANDS.findInProcesses)("eu", "trade", true);
  assert.deepStrictEqual(outcomes.map((o) => [o.process, "error" in o]), [
    ["rdb", false],
    ["hdb", false],
    ["gone", true],
  ]);
  assert.deepStrictEqual(q.sent, [[SEARCH, "trade", true, SEARCH_LIMIT]]);
  // The us-tagged process shares hdb's port: only hdb's search reached it.
  assert.strictEqual(other.sent.length, 1);
  assert.deepStrictEqual(feature.tree().roots.map((r) => r.label), ["rdb", "hdb", "gone"]);
  assert.match(feature.tree().shownMessage, /"trade" in tag eu: 8 hits/);

  const opened = [];
  require("./vscode_stub.js").vscode.window.showTextDocument = async (d) => (opened.push(d), { selection: undefined, revealRange() {} });
  const text = await stub.commands.get(PROCESS_TOOL_COMMANDS.openFoundSource)({ process: "hdb", name: ".lib.f", line: 3 });
  assert.match(text, /t:trade;/);
  assert.deepStrictEqual(other.sent[1], [FUNCTION_TEXTS, ".lib.f"]);
  assert.strictEqual(opened.length, 1);
});

// The switch was read again only after the search came back, to hide its
// answer: turned off at the tag pick, the text box or the scope pick, the
// search was still sent to every tagged process (#2005).
test("turned off at a prompt, Find in Processes sends nothing (#2005)", async (t) => {
  const { q } = await setUp(t, { tags: ["eu"], answer: null, register: registerFindInProcesses });
  const key = "processes.findInProcesses.enable";
  const turn = (on) => {
    stub.config.user[key] = on;
    stub.changeConfig(`q-lint.${key}`);
  };
  const offThen = (answer) => (options) => (turn(false), typeof answer === "function" ? answer(options) : answer);
  const first = (o) => o.items[0];
  for (const [picks, inputs] of [
    [[offThen(first), first], ["trade"]],
    [[first, first], [offThen("trade")]],
    [[first, offThen(first)], ["trade"]],
  ]) {
    turn(true);
    stub.picks.push(...picks);
    stub.inputs.push(...inputs);
    assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.findInProcesses)(), /Find in processes is turned off/);
    assert.deepStrictEqual([stub.picks.length, stub.inputs.length], [0, 0]);
    assert.deepStrictEqual(q.sent, []);
  }
});
