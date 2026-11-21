// The q tasks and the `$q` problem matcher (#978): the matcher against what
// KDB-X and PeachQ print for a failing script (captured, and - when
// QLINT_TEST_Q names a q - printed again by that q), the detected tasks,
// the provider's on and off states through the stand-in `vscode` module,
// and a task run to its exit code on a fake q and on a real one.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pkg = require("../package.json");
const T = require("../out/tasks.js");
const { registerTasks, provideQTasks } = require("../out/taskprovider.js");

const Q = process.env.QLINT_TEST_Q;
const skipQ = Q ? false : "QLINT_TEST_Q names no q binary";

/// QLINT_TEST_Q as a program and its variables (`env A=1 q`).
function qCommand() {
  const words = Q.trim().split(/\s+/);
  if (words[0] === "env") words.shift();
  const env = {};
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const [key, ...value] = words.shift().split("=");
    env[key] = value.join("=");
  }
  return { command: words[0], args: words.slice(1), env };
}

// What each printed for a script whose third line is `c:a+`x`, run as
// `q e_type.q` with no terminal; and for a lambda failing when called on
// line 5, and a script `\l`-ing the first.
const KDBX = {
  type: "'2026.11.21T19:31:44.874 type\n  [2]  /w/err/e_type.q:3: c:a+`x\n                                ^\n",
  nested:
    "'2026.11.21T19:31:44.838 type\n  [5]  /w/err/e_type.q:3: c:a+`x\n         ^\n  [2]  /w/err/e_nested.q:2: \\l e_type.q\n                ^\n",
  parse: "'2026.11.21T19:31:44.850 (\n  [2]  /w/err/e_parse.q:2: b:(1;2\n          ^\n",
  signal: "'2026.11.21T19:31:44.861 custom failure\n  [2]  /w/err/e_signal.q:2: '\"custom failure\"\n   ^\n",
};
const PEACHQ = {
  type: "'type\r\n  [2]  /w/err/e_type.q:3: c:a+`x\r\n                       ^\r\n",
  func: "'type\n  [3]  /w/err/e_func.q:1: f:{[x]\n  y:x+1;\n  y+`a}\n   ^\n  [2]  /w/err/e_func.q:5: f 1\n    ^\n",
  undefined: "'undefinedthing\n  [2]  /w/err/e_undef.q:2: undefinedthing+1\n     ^\n",
};

test("the matcher reads KDB-X's and PeachQ's error, at the innermost frame's file and line", () => {
  assert.deepStrictEqual(T.matchProblems(KDBX.type), [{ file: "/w/err/e_type.q", line: 3, message: "type" }]);
  assert.deepStrictEqual(T.matchProblems(KDBX.nested), [{ file: "/w/err/e_type.q", line: 3, message: "type" }], "the loaded file, not the one loading it");
  assert.deepStrictEqual(T.matchProblems(KDBX.parse), [{ file: "/w/err/e_parse.q", line: 2, message: "(" }]);
  assert.deepStrictEqual(T.matchProblems(KDBX.signal), [{ file: "/w/err/e_signal.q", line: 2, message: "custom failure" }]);
  assert.deepStrictEqual(T.matchProblems(PEACHQ.type), [{ file: "/w/err/e_type.q", line: 3, message: "type" }]);
  assert.deepStrictEqual(T.matchProblems(PEACHQ.func), [{ file: "/w/err/e_func.q", line: 1, message: "type" }]);
  assert.deepStrictEqual(T.matchProblems(PEACHQ.undefined), [{ file: "/w/err/e_undef.q", line: 2, message: "undefinedthing" }]);
  // Windows paths, and an error at the console with no file: not matched.
  assert.deepStrictEqual(T.matchProblems("'type\n  [1]  C:\\w\\a.q:7: x+`a\n"), [{ file: "C:\\w\\a.q", line: 7, message: "type" }]);
  assert.deepStrictEqual(T.matchProblems("'type\n  [0]  1+`a\n       ^\n"), []);
  assert.deepStrictEqual(T.matchProblems("ok\nq)'x\n"), []);
});

test("package.json declares the matcher with exactly these patterns, and the task type", () => {
  const [m] = pkg.contributes.problemMatchers;
  assert.strictEqual(m.name, T.MATCHER.name);
  assert.strictEqual(m.owner, T.MATCHER.owner);
  assert.strictEqual(m.source, T.MATCHER.source);
  assert.deepStrictEqual(m.pattern, [
    { regexp: T.MATCHER.error, message: 1 },
    { regexp: T.MATCHER.frame, file: 1, line: 2 },
  ]);
  assert.deepStrictEqual(m.fileLocation, ["autoDetect", "${workspaceFolder}"]);
  const [d] = pkg.contributes.taskDefinitions;
  assert.strictEqual(d.type, T.TASK_TYPE);
  assert.deepStrictEqual(d.required, ["script"]);
  assert.match(d.when, /config\.q-lint\.tasks\.enable/);
  assert.ok(pkg.activationEvents.includes("onTaskType:q"));
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.tasks.enable"].default, true);
});

test("detected tasks: run current file, and one test task per runner script; definitions are checked", () => {
  assert.deepStrictEqual(T.detectedTasks(["tests\\run_tests.q", "b/runtests.q", "tests/run_tests.q"]), [
    { label: "run current file", definition: { type: "q", script: "${file}" }, test: false },
    { label: "test b/runtests.q", definition: { type: "q", script: "b/runtests.q" }, test: true },
    { label: "test tests/run_tests.q", definition: { type: "q", script: "tests/run_tests.q" }, test: true },
  ]);
  assert.deepStrictEqual(T.readTaskDefinition({ type: "q", script: " t.q ", args: ["-p", 5, "1"] }), { type: "q", script: "t.q", args: ["-p", "1"] });
  assert.strictEqual(T.readTaskDefinition({ type: "shell", script: "t.q" }), undefined);
  assert.strictEqual(T.readTaskDefinition({ type: "q" }), undefined);
  assert.strictEqual(T.terminalText("a\nb\r\nc"), "a\r\nb\r\nc");
});

/// The stand-in's task API: providers, tasks and executions kept.
function setUp(t, folder) {
  stub.reset();
  const providers = [];
  vscode.tasks = {
    registerTaskProvider: (type, provider) => {
      const entry = { type, provider, disposed: false, dispose() { this.disposed = true; } };
      providers.push(entry);
      return entry;
    },
  };
  vscode.Task = class {
    constructor(definition, scope, name, source, execution, matchers) {
      Object.assign(this, { definition, scope, name, source, execution, matchers });
    }
  };
  vscode.CustomExecution = class {
    constructor(callback) {
      this.callback = callback;
    }
  };
  vscode.RelativePattern = class {
    constructor(base, pattern) {
      Object.assign(this, { base, pattern });
    }
  };
  vscode.TaskGroup = { Test: "test" };
  vscode.TaskScope = { Workspace: 2 };
  vscode.workspace.workspaceFolders = folder ? [{ uri: vscode.Uri.file(folder), name: path.basename(folder), index: 0 }] : undefined;
  vscode.workspace.getWorkspaceFolder = () => vscode.workspace.workspaceFolders?.[0];
  vscode.workspace.fs = { readFile: async (uri) => fs.readFileSync(uri.fsPath) };
  vscode.workspace.findFiles = async (pattern) => {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== "node_modules") walk(p);
        else if (/^(run_tests|runtests|run_all_tests|run_test|test_runner|testrunner)\.q$/.test(e.name)) out.push(vscode.Uri.file(p));
      }
    };
    walk(pattern.base.uri.fsPath);
    return out;
  };
  const context = stub.newContext();
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
    vscode.workspace.workspaceFolders = undefined;
  });
  return { providers, registered: registerTasks(context) };
}

/// Run `task`'s execution to its end: what it wrote, and its exit code.
async function run(task, resolved = task.definition) {
  const terminal = await task.execution.callback(resolved);
  let out = "";
  const code = await new Promise((resolve) => {
    terminal.onDidWrite((text) => (out += text));
    terminal.onDidClose((c) => resolve(c));
    terminal.open();
  });
  return { out, code };
}

test("the provider offers the detected tasks; a task runs q on its script with the .env file's variables and ends with its exit code", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tasks-"));
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "tests", "run_tests.q"), "");
  fs.writeFileSync(path.join(dir, ".env"), "FROM_ENV=hello\n");
  // A q standing in: prints its arguments and a variable, fails on fail.q
  // as q does.
  const fakeQ = path.join(dir, "fakeq");
  fs.writeFileSync(fakeQ, `#!/bin/sh\necho "args: $* env: $FROM_ENV"\ncase "$1" in *fail.q) echo "'type" >&2; echo "  [1]  $1:2: x" >&2; exit 1;; esac\nexit 0\n`);
  fs.chmodSync(fakeQ, 0o755);
  const { providers, registered } = setUp(t, dir);
  stub.config.user["terminal.qBinary"] = fakeQ;
  assert.ok(registered.registered());
  assert.strictEqual(providers[0].type, "q");
  const found = await providers[0].provider.provideTasks();
  assert.deepStrictEqual(found.map((x) => [x.name, x.definition.script, x.group]), [
    ["run current file", "${file}", undefined],
    ["test tests/run_tests.q", "tests/run_tests.q", "test"],
  ]);
  assert.deepStrictEqual(found[1].matchers, ["$q"]);
  const ok = await run(found[1]);
  assert.strictEqual(ok.code, 0);
  assert.match(ok.out, new RegExp(`args: ${path.join(dir, "tests", "run_tests.q").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} env: hello\\r\\n`));
  // ${file}, as VS Code resolves it, and a tasks.json task with arguments.
  const current = await run(found[0], { type: "q", script: path.join(dir, "fail.q") });
  assert.strictEqual(current.code, 1);
  assert.deepStrictEqual(T.matchProblems(current.out.replace(/\r\n/g, "\n")), [{ file: path.join(dir, "fail.q"), line: 2, message: "type" }]);
  const own = providers[0].provider.resolveTask({ definition: { type: "q", script: "x.q", args: ["-a", "b"] }, name: "mine", scope: vscode.workspace.workspaceFolders[0] });
  assert.match((await run(own)).out, /args: .*x\.q -a b env: hello/);
});

test("off: the provider is unregistered, offers and resolves nothing, and runs no q", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tasksoff-"));
  const { providers, registered } = setUp(t, dir);
  stub.config.user["tasks.enable"] = false;
  stub.changeConfig("q-lint.tasks.enable");
  assert.strictEqual(registered.registered(), false);
  assert.ok(providers[0].disposed);
  assert.deepStrictEqual(await provideQTasks(), []);
  assert.strictEqual(providers[0].provider.resolveTask({ definition: { type: "q", script: "x.q" }, name: "x" }), undefined);
  stub.config.user["tasks.enable"] = true;
  stub.changeConfig("q-lint.tasks.enable");
  assert.strictEqual(providers.length, 2, "on again at once");
  assert.ok(registered.registered());
});

test("a real q's failing scripts are matched as it prints them", { skip: skipQ }, () => {
  const { command, args, env } = qCommand();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-matcher-"));
  fs.writeFileSync(path.join(dir, "e_type.q"), "a:1\nb:2\nc:a+`x\nd:4\n");
  fs.writeFileSync(path.join(dir, "e_nested.q"), "a:1\n\\l e_type.q\nb:2\n");
  fs.writeFileSync(path.join(dir, "e_undef.q"), "a:1\nundefinedthing+1\n");
  fs.writeFileSync(path.join(dir, "ok.q"), "a:1\n-1 \"loaded\";\n");
  const runQ = (file) => spawnSync(command, [...args, file], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20_000 });
  const real = (p) => fs.realpathSync(path.dirname(p)) + path.sep + path.basename(p);
  for (const [file, at, message] of [["e_type.q", ["e_type.q", 3], "type"], ["e_nested.q", ["e_type.q", 3], "type"], ["e_undef.q", ["e_undef.q", 2], "undefinedthing"]]) {
    const r = runQ(file);
    assert.strictEqual(r.status, 1, `${file}: q exits 1 at the error with no input`);
    const problems = T.matchProblems(r.stdout + r.stderr);
    assert.strictEqual(problems.length, 1, `${file}: ${r.stderr}`);
    assert.strictEqual(real(problems[0].file), real(path.join(dir, at[0])));
    assert.strictEqual(problems[0].line, at[1]);
    assert.strictEqual(problems[0].message, message);
  }
  const ok = runQ("ok.q");
  assert.strictEqual(ok.status, 0);
  assert.deepStrictEqual(T.matchProblems(ok.stdout + ok.stderr), []);
});

test("a q task on a real q: .env variables reach it, and its error reaches the matcher", { skip: skipQ }, async (t) => {
  const { command, args, env } = qCommand();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-taskq-"));
  // QLINT_TEST_Q's own variables come from the .env file here.
  fs.writeFileSync(path.join(dir, ".env"), [...Object.entries(env).map(([k, v]) => `${k}=${v}`), "QLINT_DOTENV=from-dotenv"].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "run_tests.q"), '-1 "seen ",getenv`QLINT_DOTENV;\nx:1\ny:x+`a\n');
  const { providers } = setUp(t, dir);
  stub.config.user["terminal.qBinary"] = command;
  const found = await providers[0].provider.provideTasks();
  const task = found.find((x) => x.name === "test run_tests.q");
  const { out, code } = await run(task, { ...task.definition, ...(args.length ? { args } : {}) });
  assert.strictEqual(code, 1);
  assert.match(out, /seen from-dotenv/);
  const problems = T.matchProblems(out.replace(/\r\n/g, "\n"));
  assert.strictEqual(problems.length, 1, out);
  assert.strictEqual(problems[0].line, 3);
  assert.strictEqual(path.basename(problems[0].file), "run_tests.q");
});
