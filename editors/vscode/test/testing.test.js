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
  splitMatch,
} = require("../out/testing.js");
const { guardText, writes } = require("../out/guard.js");
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

test("a k4unit row is run its repeat times, as KUpexec runs it: do[n;code] (#2100)", () => {
  const rows = parseK4unit(
    [
      "action,ms,bytes,lang,code,repeat,minver,comment",
      "before,0,0,q,cnt+:1,3,,",
      "true,0,0,q,cnt=3,1,,",
      "run,0,0,k,x+:1,2,,",
      "true,0,0,q,1b,,,",
      "true,0,0,q,1b,-4,,",
      "",
    ].join("\n"),
  );
  assert.deepStrictEqual(
    rows.map((r) => r.repeat),
    [3, 1, 2, 1, 1],
  );
  assert.deepStrictEqual(rows.map(k4Statement), ["do[3;cnt+:1]", "cnt=3", "k)do[2;x+:1]", "1b", "1b"]);
  // A row built without one is run once.
  assert.strictEqual(k4Statement({ action: "true", lang: "q", code: "1b", line: 0, minver: 0 }), "1b");
});

test("a true row's ~ with an adverb or : after it is not split into two sides (#2101)", () => {
  for (const code of ["1~'1", "x~/:y", "x~\\:y", "a~:b"]) {
    assert.strictEqual(splitMatch(code), undefined, code);
  }
  assert.deepStrictEqual(splitMatch("f[1]~3"), { left: "f[1]", right: "3" });
  // An adverb after the right side's first term is the right side's own.
  assert.deepStrictEqual(splitMatch("x~1+'2"), { left: "x", right: "1+'2" });
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
    // Keyed by id, as VS Code's collection is: a second of one id replaces
    // the first.
    add(item) {
      const at = list.findIndex((i) => i.id === item.id);
      if (at >= 0) list.splice(at, 1);
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
          const run = { request, name, events: [], output: "", token: { isCancellationRequested: false } };
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
  assert.deepStrictEqual(explorer.items(), ["file:///ws/k.csv#true:t=1", "file:///ws/k.csv#fail:bad"]);
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

test("a repeated k4unit row is sent as do[n;code], a true row's a~b too: not split into its sides (#2100)", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const csv = "action,ms,bytes,lang,code,repeat,minver,comment\nbefore,0,0,q,cnt+:1,3,,\ntrue,0,0,q,cnt~3,1,,\ntrue,0,0,q,cnt~3,2,,\n";
  vscode.workspace.findFiles = async () => [vscode.Uri.file("/ws/k.csv")];
  vscode.workspace.fs = { readFile: async () => Buffer.from(csv) };
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  await explorer.run();
  assert.deepStrictEqual(
    live.sent.map((s) => [s.statements.join(";"), s.mode]),
    [
      ["do[3;cnt+:1]", "run"],
      ["(cnt;3)", "match"],
      ["do[2;cnt~3]", "true"],
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
  assert.ok(made[0].runs[0].events.some(([e, id]) => e === "skipped" && id === "file:///ws/k.csv#fail:bad"));
});

test("Stop while a test runs stops waiting for it, as Abort does: the test errors, the rest are skipped, nothing more is sent (#2102)", async () => {
  stub.reset();
  const made = fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const csv = "action,ms,bytes,lang,code,repeat,minver,comment\nbefore,0,0,q,t:1,1,,\nrun,0,0,q,hang[],1,,\ntrue,0,0,q,t=1,1,,\nafter,0,0,q,t:0,1,,\n";
  vscode.workspace.findFiles = async () => [vscode.Uri.file("/ws/k.csv")];
  vscode.workspace.fs = { readFile: async () => Buffer.from(csv) };
  // A process that never answers hang[]: only an abort ends the wait.
  const live = fakeLive();
  let fail;
  live.aborts = 0;
  live.abort = async () => {
    live.aborts++;
    fail?.(new Error("connection closed"));
  };
  const answer = live.runOnActive.bind(live);
  live.runOnActive = (code, query) => {
    if (code !== "hang[]") return answer(code, query);
    live.sent.push({ statements: [code], mode: "run" });
    return new Promise((_, reject) => (fail = reject));
  };
  const listeners = [];
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(f) {
      listeners.push(f);
      return { dispose: () => listeners.splice(listeners.indexOf(f), 1) };
    },
  };
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  const ran = made[0].profiles[0].handler(new vscode.TestRunRequest(undefined), token);
  while (!live.sent.some((s) => s.statements[0] === "hang[]")) await new Promise((r) => setImmediate(r));
  token.isCancellationRequested = true;
  listeners.forEach((f) => f());
  const ended = await Promise.race([ran.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
  assert.strictEqual(ended, true, "the run ends once stopped");
  assert.strictEqual(live.aborts, 1);
  assert.deepStrictEqual(
    live.sent.map((s) => s.statements.join(";")),
    ["t:1", "hang[]"],
  );
  const states = explorer.results().map((r) => [r.id.split("#")[1], r.state]);
  assert.deepStrictEqual(states, [
    ["run:hang[]", "errored"],
    ["true:t=1", "skipped"],
  ]);
  assert.match(explorer.results()[0].message, /^Stopped while it ran/);
  assert.deepStrictEqual(listeners, [], "the run stops listening once it ends");
  assert.ok(made[0].runs[0].events.some(([e]) => e === "end"));
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

test("two tests of one name under two \\d's in a file are two tests, each run (#1592)", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const listed = [
    {
      uri: "file:///w/t.q",
      tests: [
        { name: "test_x", range: range(1, 0, 6), code: "\\d .a\ntest_x:{1b}\n\\d .", call: ".a.test_x[]", qualified: ".a.test_x" },
        { name: "test_x", range: range(3, 0, 6), code: "\\d .b\ntest_x:{0b}\n\\d .", call: ".b.test_x[]", qualified: ".b.test_x" },
      ],
    },
  ];
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => listed }));
  await explorer.discover();
  assert.deepStrictEqual(explorer.items(), ["file:///w/t.q#.a.test_x", "file:///w/t.q#.b.test_x"]);
  await explorer.run();
  assert.deepStrictEqual(live.sent.map((s) => s.statements.at(-1)), [".a.test_x[]", ".b.test_x[]"]);
});

test("k4unit's beforeany, beforeeach, aftereach and afterall rows run as KUrt runs them (#1593)", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const head = "action,ms,bytes,lang,code,repeat,minver,comment\n";
  const files = {
    "/ws/a.csv": head + "beforeany,0,0,q,once:1,1,,\nbeforeeach,0,0,q,each:1,1,,\nbefore,0,0,q,a:1,1,,\ntrue,0,0,q,a=1,1,,\nafter,0,0,q,a:0,1,,\naftereach,0,0,q,each:0,1,,\nafterall,0,0,q,once:0,1,,\n",
    "/ws/b.csv": head + "true,0,0,q,b=1,1,,\n",
  };
  vscode.workspace.findFiles = async () => Object.keys(files).map((f) => vscode.Uri.file(f));
  vscode.workspace.fs = { readFile: async (uri) => Buffer.from(files[uri.fsPath]) };
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  await explorer.run();
  assert.deepStrictEqual(
    live.sent.map((s) => s.statements.join(";")),
    ["once:1", "each:1", "a:1", "a=1", "a:0", "each:0", "each:1", "b=1", "each:0", "once:0"],
  );
});

test("a k4unit row whose minver is above the process's .z.K is skipped, not run (#1594)", async () => {
  stub.reset();
  const made = fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const csv = "action,ms,bytes,lang,code,repeat,minver,comment\ntrue,0,0,q,1b,1,,\ntrue,0,0,q,.z.K>=99,1,99,\nbefore,0,0,q,new:1,1,99,\n";
  vscode.workspace.findFiles = async () => [vscode.Uri.file("/ws/k.csv")];
  vscode.workspace.fs = { readFile: async () => Buffer.from(csv) };
  const live = fakeLive();
  const runOnActive = live.runOnActive.bind(live);
  live.runOnActive = async (code, query, ...rest) =>
    guardText(code) === ".z.K" ? { process: "dev", value: { passed: true, text: "4.1", errored: false } } : runOnActive(code, query, ...rest);
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  await explorer.run();
  assert.deepStrictEqual(live.sent.map((s) => s.statements.join(";")), ["1b"]);
  assert.deepStrictEqual(explorer.results().map((r) => r.state), ["passed", "skipped"]);
  assert.ok(made[0].runs[0].events.some(([e]) => e === "skipped"));
});

test("a k4unit row keeps its id when a row is inserted above it: Re-run Failed runs the row that failed (#1595)", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  stub.config.user["testExplorer.failedTests.enable"] = true;
  const head = "action,ms,bytes,lang,code,repeat,minver,comment\n";
  let csv = head + "true,0,0,q,bad=1,1,,\ntrue,0,0,q,good=1,1,,\ntrue,0,0,q,good=1,1,,\n";
  vscode.workspace.findFiles = async () => [vscode.Uri.file("/ws/suite.csv")];
  vscode.workspace.fs = { readFile: async () => Buffer.from(csv) };
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => undefined);
  await explorer.discover();
  // Two rows of one code are told apart.
  assert.deepStrictEqual(explorer.items(), ["file:///ws/suite.csv#true:bad=1", "file:///ws/suite.csv#true:good=1", "file:///ws/suite.csv#true:good=1#2"]);
  await explorer.run();
  csv = head + "true,0,0,q,new=1,1,,\ntrue,0,0,q,bad=1,1,,\ntrue,0,0,q,good=1,1,,\ntrue,0,0,q,good=1,1,,\n";
  await explorer.discover();
  live.sent.length = 0;
  await stub.commands.get("q-lint.rerunFailedTests")();
  assert.deepStrictEqual(live.sent.map((s) => s.statements.join(";")), ["bad=1"]);
});

test("a run whose selection holds a file and one of its tests runs that test once (#1596)", async () => {
  stub.reset();
  const made = fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => LISTED }));
  await explorer.discover();
  const file = made[0].items.list[0];
  const good = file.children.list[0];
  await made[0].profiles[0].handler(new vscode.TestRunRequest([file, good]), { isCancellationRequested: false });
  assert.deepStrictEqual(live.sent.map((s) => s.statements.at(-1)), [".t.test_good[]", ".t.test_bad[]"]);
});

test("Stop stops a Re-run Failed run: what is still queued is not sent (#1597)", async () => {
  stub.reset();
  const made = fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  stub.config.user["testExplorer.failedTests.enable"] = true;
  const live = fakeLive();
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => LISTED }));
  await explorer.discover();
  await explorer.run();
  // Stop pressed as the re-run starts: VS Code cancels the run's token.
  const createTestRun = made[0].createTestRun.bind(made[0]);
  made[0].createTestRun = (...args) => {
    const run = createTestRun(...args);
    run.token.isCancellationRequested = true;
    return run;
  };
  live.sent.length = 0;
  await stub.commands.get("q-lint.rerunFailedTests")();
  assert.deepStrictEqual(live.sent, []);
  assert.deepStrictEqual(explorer.results().map((r) => r.state), ["skipped"]);
});

test("one run at a time, and a busy process is asked once, not once per test (#1598)", async () => {
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const live = fakeLive();
  const runOnActive = live.runOnActive.bind(live);
  let inFlight = 0;
  let most = 0;
  live.runOnActive = async (...args) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    try {
      return await runOnActive(...args);
    } finally {
      inFlight--;
    }
  };
  const explorer = registerTestExplorer(stub.newContext(), live, () => ({ sendRequest: async () => LISTED }));
  await explorer.discover();
  // A second run asked for while the first is under way waits for it.
  await Promise.all([explorer.run(), explorer.run()]);
  assert.strictEqual(most, 1);
  assert.strictEqual(live.sent.length, 4);
  // Busy: the first test says so, and the rest are not sent.
  let asked = 0;
  live.runOnActive = async () => (asked++, undefined);
  await explorer.run();
  assert.strictEqual(asked, 1);
  assert.deepStrictEqual(explorer.results().map((r) => r.state), ["errored", "errored"]);
  assert.match(explorer.results()[1].message, /Not run/);
});

test("a CSV that is not a k4unit suite is turned down from its first line, not read whole (#1606)", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-csv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "data.csv"), "sym,price\n" + "a,1\n".repeat(10000));
  fs.writeFileSync(path.join(dir, "suite.csv"), "action,ms,bytes,lang,code,repeat,minver,comment\ntrue,0,0,q,1b,1,,\n");
  vscode.workspace.findFiles = async (glob) => (glob.endsWith(".csv") ? ["data.csv", "suite.csv"].map((f) => vscode.Uri.file(path.join(dir, f))) : []);
  const whole = [];
  vscode.workspace.fs = { readFile: async (uri) => (whole.push(path.basename(uri.fsPath)), fs.readFileSync(uri.fsPath)) };
  const explorer = registerTestExplorer(stub.newContext(), fakeLive(), () => undefined);
  await explorer.discover();
  assert.deepStrictEqual(whole, ["suite.csv"]);
  assert.strictEqual(explorer.items().length, 1);
});

test("the guard reads a k4unit row's code as TEST_RUN values it, whole (#2033)", () => {
  const { testRunGuardCode } = require("../out/testing.js");
  const rows = parseK4unit('action,ms,bytes,lang,code,repeat,minver,comment\ntrue,0,0,q,"(1;\n/\nkk:9)",1,,\n');
  assert.strictEqual(rows[0].code, "(1;\n/\nkk:9)");
  assert.deepStrictEqual(writes(testRunGuardCode([k4Statement(rows[0])])), ["assigns kk"]);
  assert.deepStrictEqual(writes(testRunGuardCode(["1b"])), []);
});
