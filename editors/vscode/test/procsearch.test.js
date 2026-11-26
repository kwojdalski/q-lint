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

// Each process was searched within its own timeout only, 0 unless it had
// one, and the notification had no Cancel: one that never answered kept the
// search, and every other process's hits, from ever being shown.
test("a process that does not answer is given up at q-lint.query.timeout, and Cancel shows what the rest found (#2161)", async (t) => {
  const { SILENT } = require("./fakeq.js");
  const hung = await fakeQ(SILENT);
  t.after(() => hung.close());
  await setUp(t, { tags: ["eu"], answer, register: registerFindInProcesses, config: { "query.timeout": 1 }, more: [{ label: "hung", port: hung.port, tags: ["eu"] }] });
  const { vscode } = require("./vscode_stub.js");
  const started = Date.now();
  const outcomes = await stub.commands.get(PROCESS_TOOL_COMMANDS.findInProcesses)("eu", "trade", false);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.deepStrictEqual(outcomes.map((o) => [o.process, "found" in o]), [["rdb", true], ["hung", false]]);
  assert.match(outcomes[1].error, /did not answer within 1 s \(q-lint\.query\.timeout\)/);
  // With no timeout, Cancel ends it: the notification can be cancelled, and the hits that came back are shown.
  stub.config.user["query.timeout"] = 0;
  const shown = vscode.window.withProgress;
  t.after(() => (vscode.window.withProgress = shown));
  let options;
  vscode.window.withProgress = async (o, task) => {
    options = o;
    const listeners = [];
    const token = { isCancellationRequested: false, onCancellationRequested: (f) => (listeners.push(f), { dispose() {} }) };
    setTimeout(() => ((token.isCancellationRequested = true), listeners.forEach((f) => f())), 300);
    return task({ report() {} }, token);
  };
  const cancelled = await stub.commands.get(PROCESS_TOOL_COMMANDS.findInProcesses)("eu", "trade", false);
  assert.strictEqual(options.cancellable, true);
  assert.deepStrictEqual(cancelled.map((o) => [o.process, "found" in o ? "found" : o.error]), [["rdb", "found"], ["hung", "cancelled before it answered"]]);
});

// A process still connecting when the search was cancelled finished its
// handshake later, and was sent the search all the same (#2554).
test("cancelled while a process is still connecting, the search is never sent to it", async (t) => {
  const net = require("node:net");
  const { serialize, deserialize } = require("node-q/lib/c.js");
  const sent = [];
  const sockets = new Set();
  const slow = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        setTimeout(() => socket.destroyed || socket.write(Buffer.from([3])), 600);
        return;
      }
      sent.push(deserialize(chunk));
      const out = serialize(null);
      out.writeUInt8(2, 1);
      socket.write(out);
    });
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  t.after(() => (sockets.forEach((s) => s.destroy()), slow.close()));
  await setUp(t, { tags: ["eu"], answer, register: registerFindInProcesses, config: { "query.timeout": 0 }, more: [{ label: "busy", port: slow.address().port, tags: ["eu"] }] });
  const { vscode } = require("./vscode_stub.js");
  const shown = vscode.window.withProgress;
  t.after(() => (vscode.window.withProgress = shown));
  vscode.window.withProgress = async (o, task) => {
    const listeners = [];
    const token = { isCancellationRequested: false, onCancellationRequested: (f) => (listeners.push(f), { dispose() {} }) };
    setTimeout(() => ((token.isCancellationRequested = true), listeners.forEach((f) => f())), 200);
    return task({ report() {} }, token);
  };
  const outcomes = await stub.commands.get(PROCESS_TOOL_COMMANDS.findInProcesses)("eu", "trade", false);
  assert.deepStrictEqual(outcomes.map((o) => [o.process, "found" in o ? "found" : o.error]), [["rdb", "found"], ["busy", "cancelled before it answered"]]);
  await new Promise((r) => setTimeout(r, 900));
  assert.deepStrictEqual(sent.map((m) => (Array.isArray(m) ? m[0] : m)).filter((h) => h === SEARCH), []);
});

// q's lower changes A to Z only: "ünï" found nothing in "Ünï", and the box
// said the search ignored case.
test("the text box says only A to Z are matched in either case, as q's lower does (#2166)", async (t) => {
  await setUp(t, { tags: ["eu"], answer, register: registerFindInProcesses });
  let prompt;
  stub.inputs.push((o) => ((prompt = o.prompt), "trade"));
  stub.picks.push((o) => o.items[0]);
  await stub.commands.get(PROCESS_TOOL_COMMANDS.findInProcesses)("eu");
  assert.strictEqual(prompt, "Text to find in function definitions; A to Z match in either case, other letters only as written.");
});
