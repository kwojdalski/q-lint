// The Test Explorer integration (#939): what the server's list and a
// k4unit CSV become, how a test is sent and judged, and the controller's
// life - registered only while q-lint.testExplorer.enable is on, and
// sending nothing when it is off. The q side is testing_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const {
  readServerTests,
  testStatements,
  readTestResult,
  failureText,
  parseK4unit,
  isK4Test,
  k4Mode,
  k4Statement,
  k4Label,
} = require("../out/testing.js");
const { registerTestExplorer, TESTS_REQUEST } = require("../out/testexplorer.js");
const { EDITOR_SETTINGS, editorFeatureOn, editorFeatureOff } = require("../out/editorfeatures.js");
const pkg = require("../package.json");

const range = (line, a, b) => ({ start: { line, character: a }, end: { line, character: b } });

test("the server's list keeps what is well formed", () => {
  const good = { name: "test_a", range: range(2, 0, 6), code: "\\d .t\ntest_a:{[] 1b}\n\\d .", call: ".t.test_a[]" };
  assert.deepStrictEqual(
    readServerTests([
      { uri: "file:///a.q", tests: [good, { name: "x" }, null] },
      { uri: "file:///b.q", tests: [] },
      { tests: [good] },
      "junk",
    ]),
    [{ uri: "file:///a.q", tests: [good] }],
  );
  assert.deepStrictEqual(readServerTests(null), []);
});

test("a test's code is sent one \\d line or definition at a time, then the call", () => {
  assert.deepStrictEqual(testStatements({ code: "\\d .qt.m\ntest_x:{[]\n  1b}\n\\d .", call: ".qt.m.test_x[]" }), [
    "\\d .qt.m",
    "test_x:{[]\n  1b}",
    "\\d .",
    ".qt.m.test_x[]",
  ]);
  assert.deepStrictEqual(testStatements({ code: "test_y:{[] 1b}", call: "test_y[]" }), ["test_y:{[] 1b}", "test_y[]"]);
});

test("a result is read and a failure says why", () => {
  assert.deepStrictEqual(readTestResult({ ok: true, failed: false, text: "1b" }), { passed: true, text: "1b", errored: false });
  const error = readTestResult({ ok: false, failed: true, text: "boom" });
  assert.strictEqual(failureText(error, "test"), "'boom");
  assert.strictEqual(failureText(readTestResult({ ok: true, failed: true, text: "0b" }), "test"), "returned 0b");
  assert.strictEqual(failureText(readTestResult({ ok: true, failed: true, text: "2" }), "true"), "expected 1b, got 2");
  assert.match(failureText(readTestResult({ ok: true, failed: true, text: "3" }), "fail"), /expected an error/);
  // A one-character text comes back as a char.
  assert.strictEqual(readTestResult({ ok: false, failed: true, text: ["x"] }).text, "x");
  assert.throws(() => readTestResult({ value: 1 }), /something other than a test's result/);
});

test("a k4unit suite is read from its CSV, quoted code and all", () => {
  const csv = [
    "action,ms,bytes,lang,code,repeat,minver,comment",
    "before,0,0,q,t:([] a:1 2 3),1,,setup",
    'true,0,0,q,"3=count t",1,,',
    'true,0,0,k,"3=#t",1,,',
    'fail,0,0,q,"1+`a",1,,a type error',
    'run,0,0,q,"x:sum {x,y}[1;2]",1,,',
    "comment,0,0,q,whatever,1,,",
    "after,0,0,q,delete t from `.,1,,",
    "",
  ].join("\r\n");
  const rows = parseK4unit(csv);
  assert.deepStrictEqual(
    rows.map((r) => [r.action, r.lang, r.code, r.line]),
    [
      ["before", "q", "t:([] a:1 2 3)", 1],
      ["true", "q", "3=count t", 2],
      ["true", "k", "3=#t", 3],
      ["fail", "q", "1+`a", 4],
      ["run", "q", "x:sum {x,y}[1;2]", 5],
      ["after", "q", "delete t from `.", 7],
    ],
  );
  assert.deepStrictEqual(rows.filter(isK4Test).map(k4Mode), ["true", "true", "fail", "run"]);
  assert.strictEqual(k4Statement(rows[2]), "k)3=#t");
  assert.strictEqual(k4Label({ code: "a:1;\n  b:2" }), "a:1; b:2");
  // Cut by code point: an emoji at the cut is kept whole or left out (#1473).
  const long = "x".repeat(78) + "\u{1F600}\u{1F600}" + "y";
  assert.strictEqual(k4Label({ code: long }), "x".repeat(78) + "\u{1F600}…");
  // A field over two lines; any other CSV is no suite.
  assert.strictEqual(parseK4unit('action,ms,lang,code\ntrue,0,q,"1b\n  "\n')[0].line, 1);
  // A quote opens quoting only at a field's start, as q's 0: reads it (#1410).
  assert.strictEqual(parseK4unit('action,ms,bytes,lang,code,repeat,minver,comment\ntrue,0,0,q,s~"abc",1,,\n')[0].code, 's~"abc"');
  assert.strictEqual(parseK4unit("a,b,c\n1,2,3\n"), undefined);
  assert.strictEqual(parseK4unit(""), undefined);
});

test("the switch is declared, on by default, and named in what a refusal says", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  const { key, fallback } = EDITOR_SETTINGS.testExplorer;
  assert.strictEqual(props[`q-lint.${key}`].default, true);
  assert.strictEqual(fallback, true);
  assert.strictEqual(editorFeatureOn(() => false, "testExplorer"), false);
  assert.strictEqual(editorFeatureOn(() => "yes", "testExplorer"), true);
  assert.match(editorFeatureOff("testExplorer"), /q-lint\.testExplorer\.enable to true/);
});

/// A Testing API that records what is made of it.
function fakeTests() {
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
          const profile = { label, kind, handler, isDefault };
          this.profiles.push(profile);
          return profile;
        },
        createTestRun(request, name) {
          const run = { request, name, events: [], output: "" };
          for (const e of ["enqueued", "started", "passed", "failed", "errored", "skipped"]) {
            run[e] = (item, extra) => run.events.push([e, item.id, extra?.message ?? extra]);
          }
          run.appendOutput = (text) => (run.output += text);
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
  vscode.workspace.createFileSystemWatcher = () => ({
    onDidCreate: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    onDidChange: () => ({ dispose() {} }),
    dispose() {},
  });
  vscode.workspace.onDidSaveTextDocument = () => ({ dispose() {} });
  vscode.workspace.asRelativePath = (uri) => String(uri.fsPath).replace(/^file:\/\//, "");
  vscode.workspace.findFiles = async () => [];
  return made;
}

/// A Live with a process to run on, recording what is sent.
function fakeLive(process = { label: "dev", tags: [] }) {
  const sent = [];
  return {
    sent,
    connects: 0,
    active: process,
    activeProcess() {
      return this.active;
    },
    async connectTo() {
      this.connects++;
      this.active = process;
      return true;
    },
    async runOnActive(code, query) {
      const value = await query({
        call: async (_lambda, statements, mode) => {
          sent.push({ statements, mode });
          const last = statements[statements.length - 1];
          return last.includes("bad") ? { ok: false, failed: true, text: "boom" } : { ok: true, failed: false, text: "1b" };
        },
      });
      return { process: this.active.label, value };
    },
  };
}

const LISTED = [
  {
    uri: "file:///ws/suite.q",
    tests: [
      { name: "test_good", range: range(1, 0, 9), code: "\\d .t\ntest_good:{[] 1b}\n\\d .", call: ".t.test_good[]" },
      { name: "test_bad", range: range(2, 0, 8), code: "\\d .t\ntest_bad:{[] '`no}\n\\d .", call: ".t.test_bad[]" },
    ],
  },
];

test("off, there is no controller and nothing is asked or sent; on, the tests are listed and run", async () => {
  stub.reset();
  const made = fakeTests();
  const context = stub.newContext();
  const asked = [];
  const server = { sendRequest: async (method, params) => (asked.push([method, params]), LISTED) };
  const live = fakeLive();
  stub.config.user["testExplorer.enable"] = false;
  const explorer = registerTestExplorer(context, live, () => server);
  assert.strictEqual(made.length, 0);
  explorer.serverChanged();
  await explorer.discover();
  await explorer.run();
  assert.deepStrictEqual(explorer.items(), []);
  assert.deepStrictEqual(asked, []);
  assert.deepStrictEqual(live.sent, []);

  // Turned on, without a reload.
  stub.config.user["testExplorer.enable"] = true;
  stub.changeConfig("q-lint.testExplorer.enable");
  assert.strictEqual(made.length, 1);
  const controller = made[0];
  assert.deepStrictEqual(
    controller.profiles.map((p) => [p.label, p.isDefault]),
    [
      ["Run", true],
      ["Run on q Process...", false],
      ["Coverage", true],
    ],
  );
  await controller.resolveHandler(undefined);
  assert.deepStrictEqual(asked, [[TESTS_REQUEST, {}]]);
  assert.deepStrictEqual(explorer.items(), ["file:///ws/suite.q#test_good", "file:///ws/suite.q#test_bad"]);

  await explorer.run();
  assert.deepStrictEqual(live.sent, [
    { statements: ["\\d .t", "test_good:{[] 1b}", "\\d .", ".t.test_good[]"], mode: "test" },
    { statements: ["\\d .t", "test_bad:{[] '`no}", "\\d .", ".t.test_bad[]"], mode: "test" },
  ]);
  assert.deepStrictEqual(explorer.results(), [
    { id: "file:///ws/suite.q#test_good", state: "passed" },
    { id: "file:///ws/suite.q#test_bad", state: "failed", message: "'boom" },
  ]);
  assert.strictEqual(live.connects, 0, "the active connection is used");
  // Run on q Process... asks where, every time.
  await explorer.run(["file:///ws/suite.q#test_good"], true);
  assert.strictEqual(live.connects, 1);
  assert.strictEqual(live.sent.length, 3);

  // Turned off: disposed, and nothing more is sent.
  stub.config.user["testExplorer.enable"] = false;
  stub.changeConfig("q-lint.testExplorer.enable");
  assert.strictEqual(controller.disposed, true);
  await explorer.run();
  assert.strictEqual(live.sent.length, 3);
  assert.deepStrictEqual(explorer.items(), []);
});

test("with no connection, Run asks for one; a production process is confirmed first", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const server = { sendRequest: async () => LISTED };
  const live = fakeLive({ label: "live1", tags: ["prod"] });
  live.active = undefined;
  const explorer = registerTestExplorer(stub.newContext(), live, () => server);
  await explorer.discover();
  // Declined: nothing is sent.
  stub.picks.push(undefined);
  await explorer.run();
  assert.strictEqual(live.connects, 1);
  assert.deepStrictEqual(live.sent, []);
  assert.match(stub.messages.at(-1)[1], /live1 is a production process .* Run 2 tests there\?/);
  stub.picks.push("Run Tests");
  await explorer.run();
  assert.strictEqual(live.sent.length, 2);
});

test("a k4unit suite's before rows run once before its tests, and its after rows once after", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const csv = "action,ms,bytes,lang,code,repeat,minver,comment\nbefore,0,0,q,t:1,1,,\ntrue,0,0,q,t=1,1,,\nfail,0,0,q,bad,1,,\nafter,0,0,q,t:0,1,,\n";
  vscode.workspace.findFiles = async () => [vscode.Uri.file("/ws/k.csv")];
  vscode.workspace.fs = { readFile: async () => Buffer.from(csv) };
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  assert.deepStrictEqual(explorer.items(), ["file:///ws/k.csv#2", "file:///ws/k.csv#3"]);
  await explorer.run();
  assert.deepStrictEqual(
    live.sent.map((s) => [s.statements.join(";"), s.mode]),
    [
      ["t:1", "run"],
      ["t=1", "true"],
      ["bad", "fail"],
      ["t:0", "run"],
    ],
  );
});

test("a cancelled k4unit run still runs the after rows of a file it set up (#1095)", async () => {
  stub.reset();
  const made = fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const csv = "action,ms,bytes,lang,code,repeat,minver,comment\nbefore,0,0,q,t:1,1,,\ntrue,0,0,q,t=1,1,,\nfail,0,0,q,bad,1,,\nafter,0,0,q,t:0,1,,\n";
  vscode.workspace.findFiles = async () => [vscode.Uri.file("/ws/k.csv")];
  vscode.workspace.fs = { readFile: async () => Buffer.from(csv) };
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  // Cancelled once the first test has been sent: the second is skipped.
  const token = {
    get isCancellationRequested() {
      return live.sent.some((s) => s.mode === "true");
    },
  };
  await made[0].profiles[0].handler(new vscode.TestRunRequest(undefined), token);
  assert.deepStrictEqual(
    live.sent.map((s) => [s.statements.join(";"), s.mode]),
    [
      ["t:1", "run"],
      ["t=1", "true"],
      ["t:0", "run"],
    ],
  );
  assert.ok(made[0].runs[0].events.some(([e, id]) => e === "skipped" && id === "file:///ws/k.csv#3"));
});

test("a test run on a process the read-only guard guards goes through the guard: declined, the test's definition is not sent (#918)", async (t) => {
  const net = require("node:net");
  const { serialize, deserialize } = require("node-q/lib/c.js");
  const { Live } = require("../out/live.js");
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  stub.config.user["processes.readOnlyGuard.tags"] = ["live"];
  // A q process played by a socket server, which keeps what it is sent.
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        sent.push(deserialize(message));
        const out = serialize({ ok: true, failed: false, text: "1b" });
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: server.address().port, tags: ["live"] }]);
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    for (const s of sockets) s.destroy();
    server.close();
  });
  assert.strictEqual(await live.connectTo("rdb"), true);
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => LISTED }));
  await explorer.discover();
  stub.picks.push(undefined, undefined);
  await explorer.run();
  const asked = stub.messages.filter(([kind, text]) => kind === "warning" && /would change rdb/.test(text));
  assert.strictEqual(asked.length, 2);
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(
    explorer.results().map((r) => r.state),
    ["errored", "errored"],
  );
  assert.match(explorer.results()[0].message, /not confirmed/);
  // Confirmed, the tests are sent.
  stub.picks.push("Run Anyway", "Run Anyway");
  await explorer.run();
  assert.strictEqual(sent.length, 2);
});

test("a run stays on the process it started on: a connection made mid-run gets none of its tests (#1283)", async (t) => {
  const { setUp, fakeQ } = require("./fakeq.js");
  fakeTests();
  const answer = { ok: true, failed: false, text: "1b" };
  const { q, live, context } = await setUp(t, { answer, config: { "testExplorer.enable": true } });
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const other = await fakeQ(answer);
  t.after(() => other.close());
  await context.globalState.update("q-lint.processes", [
    { label: "dev", host: "127.0.0.1", port: q.port, tags: [] },
    { label: "prod", host: "127.0.0.1", port: other.port, tags: ["prod"] },
  ]);
  live.refreshProcesses();
  await live.connectTo("dev");
  // The user connects to prod once the first test has run.
  const runOnActive = live.runOnActive.bind(live);
  live.runOnActive = async (...args) => {
    const done = await runOnActive(...args);
    await live.connectTo("prod");
    return done;
  };
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => LISTED }));
  await explorer.discover();
  await explorer.run();
  assert.strictEqual(q.sent.length, 1);
  assert.deepStrictEqual(other.sent, []);
  assert.deepStrictEqual(explorer.results().map((r) => r.state), ["passed", "errored"]);
  assert.match(explorer.results()[1].message, /dev is no longer the active process; nothing was run/);
});

test("the Test Explorer turned off mid-run sends none of the tests still queued (#1277)", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const live = fakeLive();
  const runOnActive = live.runOnActive.bind(live);
  live.runOnActive = async (...args) => {
    const done = await runOnActive(...args);
    stub.config.user["testExplorer.enable"] = false;
    stub.changeConfig("q-lint.testExplorer.enable");
    return done;
  };
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => LISTED }));
  await explorer.discover();
  await explorer.run();
  assert.strictEqual(live.sent.length, 1);
});
