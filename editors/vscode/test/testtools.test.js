// Coverage, the failed-test diff and Re-run Failed, and snapshot tests in
// the Test Explorer (#979, #980, #981): each with its switch off offers and
// sends nothing; on, what is sent and what the Testing view is given. The q
// side is instrument_q.test.js, testing_q.test.js and snapshot_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { registerTestExplorer, RERUN_FAILED } = require("../out/testexplorer.js");
const { TEST_RUN } = require("../out/testing.js");
const { DRIFT } = require("../out/definitions.js");
const { installLambda, restoreExpression } = require("../out/instrument.js");
const { SNAPSHOT_RUN } = require("../out/snapshot.js");
const { coveragePlan, coverageByFile, coverageSummary, definedNames } = require("../out/coverage.js");
const { formatSnapshot } = require("../out/snapshot.js");

const range = (line, a, b) => ({ start: { line, character: a }, end: { line, character: b } });

/// A Testing API that records what is made of it, and a workspace of `files`.
function fakeVscode(files = {}) {
  const made = [];
  const items = (list) => ({
    list,
    replace(next) {
      list.splice(0, list.length, ...next);
    },
    add(item) {
      list.push(item);
    },
    forEach(f) {
      [...list].forEach(f);
    },
  });
  vscode.tests = {
    createTestController: (id, label) => {
      const controller = {
        id,
        label,
        disposed: false,
        profiles: [],
        runs: [],
        items: items([]),
        createTestItem: (id, label, uri) => ({ id, label, uri, children: items([]) }),
        createRunProfile(label, kind, handler, isDefault) {
          const profile = { label, kind, handler, isDefault, disposed: false, dispose() { this.disposed = true; controller.profiles.splice(controller.profiles.indexOf(this), 1); } };
          this.profiles.push(profile);
          return profile;
        },
        createTestRun(request, name) {
          const run = { request, name, events: [], output: "", coverage: [], token: { isCancellationRequested: false } };
          for (const e of ["enqueued", "started", "passed", "failed", "errored", "skipped"]) {
            run[e] = (item, extra) => run.events.push([e, item.id, extra]);
          }
          run.appendOutput = (text) => (run.output += text);
          run.addCoverage = (file) => run.coverage.push(file);
          run.end = () => run.events.push(["end"]);
          this.runs.push(run);
          return run;
        },
        dispose() {
          this.disposed = true;
        },
      };
      made.push(controller);
      return controller;
    },
  };
  vscode.TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 };
  vscode.TestRunRequest = class {
    constructor(include, exclude) {
      this.include = include;
      this.exclude = exclude;
    }
  };
  vscode.TestMessage = class {
    constructor(message) {
      this.message = message;
    }
    static diff(message, expected, actual) {
      return Object.assign(new vscode.TestMessage(message), { expectedOutput: expected, actualOutput: actual });
    }
  };
  vscode.Range = class {
    constructor(a, b, c, d) {
      Object.assign(this, { a, b, c, d });
    }
  };
  vscode.Location = class {
    constructor(uri, range) {
      Object.assign(this, { uri, range });
    }
  };
  vscode.StatementCoverage = class {
    constructor(executed, location) {
      Object.assign(this, { executed, location });
    }
  };
  vscode.FileCoverage = class {
    static fromDetails(uri, details) {
      return Object.assign(new vscode.FileCoverage(), { uri, details });
    }
  };
  vscode.workspace.createFileSystemWatcher = () => ({
    onDidCreate: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    onDidChange: () => ({ dispose() {} }),
    dispose() {},
  });
  vscode.workspace.onDidSaveTextDocument = () => ({ dispose() {} });
  vscode.workspace.asRelativePath = (uri) => String(uri.fsPath);
  vscode.workspace.findFiles = async (glob) => {
    const ext = glob.match(/\*\.(\w+)$/)?.[1];
    return Object.keys(files).filter((f) => f.endsWith(`.${ext}`)).map((f) => vscode.Uri.file(f));
  };
  vscode.workspace.fs = { readFile: async (uri) => Buffer.from(files[uri.fsPath], "utf8") };
  return made;
}

/// A Live whose process answers each lambda as `answer` says, recording
/// what is sent.
function fakeLive(answer, process = { label: "dev", tags: [] }) {
  const sent = [];
  return {
    sent,
    guarded: [],
    active: process,
    activeProcess() {
      return this.active;
    },
    async connectTo() {
      return true;
    },
    async runOnActive(code, query) {
      this.guarded.push(code);
      const value = await query({
        call: async (lambda, ...args) => {
          sent.push({ lambda, args });
          return answer(lambda, ...args);
        },
      });
      return { process: this.active.label, value };
    },
  };
}

const LIB = "f:{[a]\n  b:a+1;\n  $[b>2;g b;b]}\ng:{x*2}\n";
const TESTS = [
  {
    uri: "file:///ws/test.q",
    tests: [
      { name: "test_f", range: range(0, 0, 6), code: "test_f:{[] 2~f 1}", call: "test_f[]" },
      { name: "test_bad", range: range(1, 0, 8), code: "test_bad:{[] 0b}", call: "test_bad[]" },
    ],
  },
];

test("coverage plans only the functions the process holds as the file has them", () => {
  const files = [{ uri: "file:///ws/lib.q", text: LIB }];
  assert.deepStrictEqual(definedNames(files), ["f", "g"]);
  const states = new Map([
    ["f", { state: "lambda", text: "{[a]\n  b:a+1;\n  $[b>2;g b;b]}" }],
    ["g", { state: "lambda", text: "{x*3}" }],
  ]);
  const plan = coveragePlan(files, states);
  assert.deepStrictEqual(plan.names, ["f"]);
  assert.deepStrictEqual(plan.skipped, [{ name: "g", why: "changed" }]);
  assert.strictEqual(plan.src[0], "{[a]\n  .qlint.cov.hit 0;b:a+1;\n  .qlint.cov.hit 1;$[b>2;g b;b]}");
  assert.deepStrictEqual(
    plan.probes.map((p) => [p.start, p.end]),
    [
      [{ line: 1, character: 2 }, { line: 1, character: 7 }],
      [{ line: 2, character: 2 }, { line: 2, character: 14 }],
    ],
  );
  const byFile = coverageByFile(plan, [3, 0], new Set(["f"]));
  assert.deepStrictEqual(byFile.get("file:///ws/lib.q").map((s) => s.count), [3, 0]);
  assert.strictEqual(coverageSummary(byFile, 1), "Coverage: 1 of 2 statements run (50%) in 1 function across 1 file.");
  // Not installed: not counted.
  assert.strictEqual(coverageByFile(plan, [3, 0], new Set()).size, 0);
  // Missing on the process.
  assert.deepStrictEqual(coveragePlan(files, new Map()).skipped.map((s) => s.why), ["missing", "missing"]);
});

test("coverage of a lambda that opens below its name is placed on the lambda's lines (#1900)", () => {
  const marked = (text) => {
    const lines = text.split("\n");
    const states = new Map([["f", { state: "lambda", text: text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) }]]);
    return coveragePlan([{ uri: "file:///ws/a.q", text }], states).probes.map((p) => [p.start.line, lines[p.start.line].slice(p.start.character, p.end.line === p.start.line ? p.end.character : undefined)]);
  };
  assert.deepStrictEqual(marked("f:\n {x+1}\n"), [[1, "x+1"]]);
  assert.deepStrictEqual(marked("a:1\nf:\n\n   {[x] y:x+1; y}\n"), [[3, "y:x+1"], [3, "y"]]);
  assert.deepStrictEqual(marked("f:\n {[x]\n  y:x+1;\n  y*2}\n"), [[2, "y:x+1"], [3, "y*2"]]);
  // On the name's line, as before.
  assert.deepStrictEqual(marked("f : {x+1}\n"), [[0, "x+1"]]);
  assert.deepStrictEqual(marked("f:{[x]\n y:x+1;\n y}\n"), [[1, "y:x+1"], [2, "y"]]);
});

test("the Coverage profile instruments, runs the tests, puts the functions back and shows the counts; off, it is not offered", async () => {
  stub.reset();
  const made = fakeVscode({ "/ws/lib.q": LIB });
  const server = { sendRequest: async () => TESTS };
  const live = fakeLive((lambda, ...args) => {
    if (lambda === DRIFT) {
      return { name: ["f", "g"], state: ["lambda", "lambda"], text: ["{[a]\n  b:a+1;\n  $[b>2;g b;b]}", "{x*2}"] };
    }
    if (lambda === installLambda("cov")) {
      return args[0].map(() => "ok");
    }
    if (lambda === restoreExpression("cov")) {
      return { kept: [], d: [1, 1, 0] };
    }
    if (lambda === TEST_RUN) {
      return { ok: true, failed: false, text: "1b" };
    }
    throw new Error(`unexpected ${lambda}`);
  });
  stub.config.user["testExplorer.coverage.enable"] = false;
  const explorer = registerTestExplorer(stub.newContext(), live, () => server);
  assert.deepStrictEqual(explorer.profiles(), ["Run", "Run on q Process..."]);
  await explorer.discover();
  await explorer.run(undefined, false, true);
  assert.deepStrictEqual(live.sent, [], "off, a coverage run sends nothing");

  stub.config.user["testExplorer.coverage.enable"] = true;
  stub.changeConfig("q-lint.testExplorer.coverage.enable");
  assert.deepStrictEqual(explorer.profiles(), ["Run", "Run on q Process...", "Coverage"]);
  const controller = made[0];
  const profile = controller.profiles.find((p) => p.label === "Coverage");
  assert.strictEqual(profile.kind, 3);
  await explorer.run(undefined, false, true);
  const lambdas = live.sent.map((s) => s.lambda);
  // Leftovers put back, the process read, the functions replaced, the tests, then put back.
  assert.deepStrictEqual(lambdas, [restoreExpression("cov"), DRIFT, installLambda("cov"), TEST_RUN, TEST_RUN, restoreExpression("cov")]);
  assert.deepStrictEqual(live.sent[2].args[0], ["f", "g"]);
  assert.strictEqual(live.sent[2].args[3], 3);
  // The read-only guard reads the code that replaces them.
  assert.strictEqual(live.guarded[0], installLambda("cov"));
  const run = controller.runs.at(-1);
  assert.strictEqual(run.coverage.length, 1);
  assert.deepStrictEqual(run.coverage[0].details.map((d) => d.executed), [1, 1, 0]);
  assert.deepStrictEqual(await profile.loadDetailedCoverage(run, run.coverage[0]), run.coverage[0].details);
  assert.deepStrictEqual(explorer.coverage(), [{ uri: "file:///ws/lib.q", covered: 2, total: 3, hit: [1, 2], missed: [3] }]);
  assert.match(run.output, /Coverage: 2 of 3 statements run \(66\.7%\) in 2 functions across 1 file\./);
  // A plain run instruments nothing.
  const before = live.sent.length;
  await explorer.run();
  assert.deepStrictEqual(live.sent.slice(before).map((s) => s.lambda), [TEST_RUN, TEST_RUN]);

  // Turned off: the profile goes.
  stub.config.user["testExplorer.coverage.enable"] = false;
  stub.changeConfig("q-lint.testExplorer.coverage.enable");
  assert.strictEqual(profile.disposed, true);
  assert.deepStrictEqual(explorer.profiles(), ["Run", "Run on q Process..."]);
});

test("coverage of a file with unsaved edits is drawn on the lines its editor holds (#1609)", async (t) => {
  stub.reset();
  const made = fakeVscode({ "/ws/lib.q": LIB });
  const documents = vscode.workspace.textDocuments;
  t.after(() => (vscode.workspace.textDocuments = documents));
  // Three lines inserted above f, not saved.
  vscode.workspace.textDocuments = [{ uri: vscode.Uri.file("/ws/lib.q"), isDirty: true, getText: () => "/ a\n/ b\n/ c\n" + LIB }];
  const live = fakeLive((lambda, ...args) => {
    if (lambda === DRIFT) {
      return { name: ["f", "g"], state: ["lambda", "lambda"], text: ["{[a]\n  b:a+1;\n  $[b>2;g b;b]}", "{x*2}"] };
    }
    if (lambda === installLambda("cov")) {
      return args[0].map(() => "ok");
    }
    if (lambda === restoreExpression("cov")) {
      return { kept: [], d: [1, 1, 0] };
    }
    return { ok: true, failed: false, text: "1b" };
  });
  stub.config.user["testExplorer.coverage.enable"] = true;
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => TESTS }));
  await explorer.discover();
  await explorer.run(undefined, false, true);
  assert.deepStrictEqual(explorer.coverage(), [{ uri: "file:///ws/lib.q", covered: 2, total: 3, hit: [4, 5], missed: [6] }]);
  assert.ok(made.length > 0);
});

test("a coverage run says so when it measures only the first 500 q files of the workspace (#1907)", async () => {
  const cover = async (count) => {
    stub.reset();
    const files = { "/ws/lib.q": LIB };
    for (let i = 0; i < count; i++) {
      files[`/ws/more/m${i}.q`] = `m${i}:{x}\n`;
    }
    const made = fakeVscode(files);
    // As VS Code's: no more than it is asked for.
    const all = vscode.workspace.findFiles;
    const asked = [];
    vscode.workspace.findFiles = async (glob, exclude, most) => (asked.push([glob, most]), (await all(glob)).slice(0, most));
    const live = fakeLive((lambda, ...args) => {
      if (lambda === DRIFT) {
        return { name: ["f", "g"], state: ["lambda", "lambda"], text: ["{[a]\n  b:a+1;\n  $[b>2;g b;b]}", "{x*2}"] };
      }
      if (lambda === installLambda("cov")) {
        return args[0].map(() => "ok");
      }
      if (lambda === restoreExpression("cov")) {
        return { kept: [], d: [1, 1, 0] };
      }
      return { ok: true, failed: false, text: "1b" };
    });
    stub.config.user["testExplorer.coverage.enable"] = true;
    const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => TESTS }));
    await explorer.discover();
    await explorer.run(undefined, false, true);
    assert.deepStrictEqual(asked.filter(([glob]) => glob === "**/*.q"), [["**/*.q", 500]]);
    return made[0].runs.at(-1).output;
  };
  const capped = await cover(600);
  assert.match(capped, /Coverage: the workspace holds 500 q files or more; only the first 500 found are measured, and a function defined in another shows no coverage\./);
  assert.match(capped, /Coverage: 2 of 3 statements run/);
  assert.doesNotMatch(await cover(3), /only the first 500/);
});

/// As `fakeLive`, with the run's last restore on the active connection
/// failing as `end` says (a throw, or undefined for nothing sent), and a
/// connection of its own to a process answering as `apart` does.
function fakeLiveLeft(end, apart, allowed = true) {
  const live = fakeLive((lambda, ...args) => {
    if (lambda === DRIFT) {
      return { name: ["f", "g"], state: ["lambda", "lambda"], text: ["{[a]\n  b:a+1;\n  $[b>2;g b;b]}", "{x*2}"] };
    }
    if (lambda === installLambda("cov")) {
      return args[0].map(() => "ok");
    }
    if (lambda === restoreExpression("cov")) {
      return { kept: [], d: [] };
    }
    return { ok: true, failed: false, text: "1b" };
  });
  const runOnActive = live.runOnActive.bind(live);
  live.runOnActive = async (code, query, guard, expect) => (code === restoreExpression("cov") ? end() : runOnActive(code, query, guard, expect));
  live.apart = [];
  live.asked = [];
  live.guardAllows = async (code, targets, what) => (live.asked.push([code, targets.map((p) => p.label), what]), allowed);
  live.openSeparate = async (process) => ({
    call: async (lambda) => (live.apart.push([process.label, lambda]), apart()),
    abort() {},
  });
  return live;
}

test("a coverage run whose restore cannot be sent puts the functions back over a connection to the process it instrumented, or says which are left (#1892)", async () => {
  const moved = () => {
    throw new Error("dev is no longer the active process; nothing was run.");
  };
  const start = async (live) => {
    stub.reset();
    const made = fakeVscode({ "/ws/lib.q": LIB });
    stub.config.user["testExplorer.coverage.enable"] = true;
    const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => TESTS }));
    await explorer.discover();
    await explorer.run(undefined, false, true);
    return { explorer, run: made[0].runs.at(-1) };
  };
  // Another process became active before the run ended: the restore goes
  // to dev all the same, and its counts are the coverage.
  let live = fakeLiveLeft(moved, () => ({ kept: [], d: [1, 1, 0] }));
  let s = await start(live);
  assert.deepStrictEqual(live.apart, [["dev", restoreExpression("cov")]]);
  assert.deepStrictEqual(live.asked, [[restoreExpression("cov"), ["dev"], "Putting back the functions instrumented for coverage"]]);
  assert.match(s.run.output, /Coverage: 2 of 3 statements run/);
  assert.deepStrictEqual(stub.messages, []);
  // Nothing sent (no connection, a query running): the same.
  live = fakeLiveLeft(() => undefined, () => ({ kept: [], d: [1, 1, 0] }));
  s = await start(live);
  assert.deepStrictEqual(live.apart, [["dev", restoreExpression("cov")]]);
  assert.deepStrictEqual(stub.messages, []);
  // That fails too: the user is told which functions, and where.
  live = fakeLiveLeft(moved, () => {
    throw new Error("the connection is closed");
  });
  s = await start(live);
  const left =
    "q-lint: f, g may still be instrumented on dev: they could not be put back (dev is no longer the active process; nothing was run; nor over a connection of its own: the connection is closed). The next coverage run on dev puts them back first.";
  assert.deepStrictEqual(stub.messages, [["warning", left]]);
  assert.ok(s.run.output.includes(left), s.run.output);
  assert.deepStrictEqual(s.run.events.at(-1), ["end"]);
  // Declined at the guard's question: nothing is sent another way.
  live = fakeLiveLeft(() => {
    throw new Error("Not run: changing the read-only process dev was not confirmed.");
  }, () => ({ kept: [], d: [] }));
  s = await start(live);
  assert.deepStrictEqual([live.apart, live.asked], [[], []]);
  assert.match(stub.messages.at(-1)[1], /^q-lint: f, g may still be instrumented on dev: they could not be put back \(Not run: changing the read-only process dev was not confirmed\)\./);
  // Asked by the connection of its own, and declined there.
  live = fakeLiveLeft(moved, () => ({ kept: [], d: [] }), false);
  s = await start(live);
  assert.deepStrictEqual(live.apart, []);
  assert.match(stub.messages.at(-1)[1], /f, g may still be instrumented on dev/);
});

test("a coverage run that fails once the functions were replaced puts them back too (#1892)", async () => {
  stub.reset();
  const made = fakeVscode({ "/ws/lib.q": LIB });
  const apart = [];
  const live = fakeLive((lambda) => {
    if (lambda === DRIFT) {
      return { name: ["f", "g"], state: ["lambda", "lambda"], text: ["{[a]\n  b:a+1;\n  $[b>2;g b;b]}", "{x*2}"] };
    }
    if (lambda === installLambda("cov")) {
      // One status for two functions: not an answer INSTALL gives.
      return ["ok"];
    }
    if (lambda === restoreExpression("cov")) {
      return { kept: [], d: [] };
    }
    return { ok: true, failed: false, text: "1b" };
  });
  live.guardAllows = async () => true;
  live.openSeparate = async (process) => ({ call: async (lambda) => (apart.push([process.label, lambda]), { kept: [], d: [0, 0, 0] }), abort() {} });
  stub.config.user["testExplorer.coverage.enable"] = true;
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => TESTS }));
  await explorer.discover();
  await explorer.run(undefined, false, true);
  assert.deepStrictEqual(apart, [["dev", restoreExpression("cov")]]);
  const run = made[0].runs.at(-1);
  assert.match(run.output, /Coverage not counted: the process answered 1 statuses for 2 functions/);
  // The tests ran all the same, and nothing is left to put back at the end.
  assert.deepStrictEqual(live.sent.map((x) => x.lambda), [restoreExpression("cov"), DRIFT, installLambda("cov"), TEST_RUN, TEST_RUN]);
  assert.deepStrictEqual(stub.messages, []);
});

test("a failed assertion's two sides are a diff, and Re-run Failed runs only those that failed; off, neither", async () => {
  stub.reset();
  fakeVscode({ "/ws/suite.csv": "action,ms,bytes,lang,code,repeat,minver,comment\ntrue,0,0,q,f[1]~3,1,,\ntrue,0,0,q,count t,1,,\n" });
  const server = { sendRequest: async () => TESTS };
  const live = fakeLive((lambda, statements, mode) => {
    const last = statements[statements.length - 1];
    if (mode === "match") {
      return { ok: true, failed: true, text: "0b", diff: ["3\n", "2\n"] };
    }
    return last.includes("bad") ? { ok: true, failed: true, text: "0b" } : { ok: true, failed: false, text: "1b" };
  });
  stub.config.user["testExplorer.coverage.enable"] = false;
  const explorer = registerTestExplorer(stub.newContext(), live, () => server);
  await explorer.discover();
  await explorer.run();
  // The match row went as its two sides.
  assert.deepStrictEqual(live.sent.map((s) => [s.args[0].at(-1), s.args[1]]), [
    ["test_f[]", "test"],
    ["test_bad[]", "test"],
    ["(f[1];3)", "match"],
    ["count t", "true"],
  ]);
  assert.deepStrictEqual(
    explorer.results().map((r) => r.state),
    ["passed", "failed", "failed", "passed"],
  );
  assert.strictEqual(stub.commands.has(RERUN_FAILED), true);
  live.sent.length = 0;
  await stub.commands.get(RERUN_FAILED)();
  assert.deepStrictEqual(live.sent.map((s) => s.args[0].at(-1)), ["test_bad[]", "(f[1];3)"]);

  // Off: a true row goes as it is, no diff, and the command refuses.
  stub.config.user["testExplorer.failedTests.enable"] = false;
  stub.changeConfig("q-lint.testExplorer.failedTests.enable");
  live.sent.length = 0;
  await explorer.run();
  assert.deepStrictEqual(live.sent.map((s) => s.args[1]), ["test", "test", "true", "true"]);
  live.sent.length = 0;
  await stub.commands.get(RERUN_FAILED)();
  assert.deepStrictEqual(live.sent, []);
  assert.match(stub.messages.at(-1)[1], /q-lint\.testExplorer\.failedTests\.enable to true/);
});

test("the diff reaches the Testing view as TestMessage.diff", async () => {
  stub.reset();
  const made = fakeVscode({ "/ws/suite.csv": "action,ms,bytes,lang,code,repeat,minver,comment\ntrue,0,0,q,f[1]~3,1,,\n" });
  const live = fakeLive(() => ({ ok: true, failed: true, text: "0b", diff: ["3\n", "2\n"] }));
  stub.config.user["testExplorer.coverage.enable"] = false;
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  await explorer.run();
  const failed = made[0].runs[0].events.find((e) => e[0] === "failed");
  assert.strictEqual(failed[2].message, "the two sides of ~ differ");
  assert.strictEqual(failed[2].expectedOutput, "3\n");
  assert.strictEqual(failed[2].actualOutput, "2\n");
});

test("a snapshot file is a test: its query run again and compared; off, not listed", async () => {
  stub.reset();
  const snap = formatSnapshot({ query: "select from t", result: "a\n-\n1\n2" });
  const made = fakeVscode({ "/ws/__snapshots__/t.qsnap": snap, "/ws/__snapshots__/junk.qsnap": "not one" });
  let result = ["a", "-", "1", "2"];
  const live = fakeLive((lambda, statements) => {
    assert.strictEqual(lambda, SNAPSHOT_RUN);
    assert.deepStrictEqual(statements, ["select from t"]);
    return { ok: true, type: 98, text: result };
  });
  stub.config.user["testExplorer.coverage.enable"] = false;
  stub.config.user["snapshotTests.enable"] = false;
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  assert.deepStrictEqual(explorer.items(), []);
  stub.config.user["snapshotTests.enable"] = true;
  stub.changeConfig("q-lint.snapshotTests.enable");
  await explorer.discover();
  assert.deepStrictEqual(explorer.items(), ["file:///ws/__snapshots__/t.qsnap"]);
  await explorer.run();
  assert.deepStrictEqual(explorer.results(), [{ id: "file:///ws/__snapshots__/t.qsnap", state: "passed" }]);
  assert.deepStrictEqual(live.guarded, ["select from t"], "the guard reads the query");
  result = ["a", "-", "1", "3"];
  await explorer.run();
  assert.strictEqual(explorer.results()[0].state, "failed");
  const failed = made[0].runs.at(-1).events.find((e) => e[0] === "failed");
  assert.strictEqual(failed[2].expectedOutput, "a\n-\n1\n2");
  assert.strictEqual(failed[2].actualOutput, "a\n-\n1\n3");
});
