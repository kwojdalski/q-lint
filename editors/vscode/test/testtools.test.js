// Snapshot tests in the Test Explorer (#981): with the switch off the files
// are not listed; on, each is run again and compared. The q side is
// snapshot_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { registerTestExplorer, RERUN_FAILED } = require("../out/testexplorer.js");
const { TEST_RUN } = require("../out/testing.js");
const { DRIFT } = require("../out/definitions.js");
const { SNAPSHOT_RUN } = require("../out/snapshot.js");
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
          const run = { request, name, events: [], output: "", coverage: [] };
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
