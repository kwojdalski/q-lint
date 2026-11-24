// The language client's lifecycle in `extension.ts`: activation, Restart
// Server and the choice of binary, with VS Code, the language client and the
// rest of the extension replaced by stand-ins. Run after `tsc`; the server
// itself is driven by the Rust tests and the end-to-end runs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/// `promise`, or "still waiting" after `ms`.
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => "still waiting")]);

/// A fresh copy of the extension over stand-ins. `behaviour(command)` says
/// what the server named `command` does when started: "ok", "fail" or
/// "hang" (it never answers `initialize`).
function load({ settings = {}, behaviour = () => "ok", extensionPath = os.tmpdir() } = {}) {
  const world = { clients: [], errors: [], infos: [], commands: {}, started: [], queried: [], executed: [] };
  class LanguageClient {
    constructor(id, name, server, options) {
      this.command = server.run.command;
      this.outputChannel = options.outputChannel;
      this.clientOptions = options;
      this.stopped = false;
      world.clients.push(this);
    }
    start() {
      const how = behaviour(this.command);
      if (how === "ok") {
        world.started.push(this.command);
        this.initializeResult = { serverInfo: { version: "9.9.9" } };
        return Promise.resolve();
      }
      if (how === "hang") {
        return new Promise(() => {});
      }
      // As vscode-languageclient does: a server that cannot be started is
      // reported with a notification of its own, whatever the caller does.
      world.errors.push("q-lint client: couldn't create connection to server.");
      return Promise.reject(new Error(`spawn ${this.command} ENOENT`));
    }
    stop() {
      this.stopped = true;
      return Promise.resolve();
    }
    createDefaultErrorHandler() {
      return { error: () => ({ action: 1 }), closed: () => ({ action: 1 }) };
    }
  }
  const vscode = {
    Uri: { parse: (text) => ({ parsed: text }) },
    Position: class {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    commands: {
      registerCommand: (name, run) => {
        world.commands[name] = run;
        return { dispose() {} };
      },
      executeCommand: (name, ...args) => {
        world.executed.push([name, ...args]);
        return Promise.resolve(name === "vscode.executeReferenceProvider" ? [{ ref: 1 }] : undefined);
      },
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({
        get: (key, fallback) => (key in settings ? settings[key] : fallback),
        inspect: (key) => (key in settings ? { globalValue: settings[key] } : {}),
      }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showErrorMessage: (m) => world.errors.push(m),
      showInformationMessage: (m) => world.infos.push(m),
    },
  };
  const stubs = {
    vscode,
    "vscode-languageclient/node": { LanguageClient, CloseAction: { DoNotRestart: 1, Restart: 2 }, ErrorAction: { Continue: 1, Shutdown: 2 } },
    "./live": {
      Live: class {
        api() { return {}; }
        processes() { return []; }
        queryCode(code, uri) { world.queried.push([code, uri]); return Promise.resolve(); }
      },
    },
    "./agenttool": { registerAgentTool: () => () => undefined },
    "./onboardingview": { registerOnboarding() {} },
    "./notebook": { registerNotebooks: () => ({ charts: () => [] }) },
    "./notebookvarsview": { registerNotebookVariables: () => ({ variables: () => [] }) },
    "./notebookrun": { runWithParameters: async () => undefined },
    "./notebookgit": { registerNotebookGit: () => ({ diff: {}, strip: {} }) },
    "./notebookrestart": { NotebookRestart: class {} },
    "./explorerview": { ProcessExplorer: class { rows() { return []; } } },
    "./relate": { Relations: class { serverChanged() {} } },
    "./funcsourceview": { FunctionSources: class { state() { return {}; } } },
    "./infoview": { registerInfoViews: () => ({ monitor: () => [], hdb: () => [] }) },
    "./queryacross": { QueryAcross: class { state() { return {}; } } },
    "./savedqueriesview": { SavedQueries: class { queries() { return []; } } },
    "./testexplorer": { registerTestExplorer: () => ({ serverChanged() {}, discover: async () => {}, items: () => [], results: () => [], run: async () => {} }) },
    "./valuehoverview": { registerValueHover: () => ({ registered: () => false }) },
    "./undefinednamesview": { registerUndefinedNames: () => ({ registered: () => false }) },
    "./idiomsview": { registerIdioms: () => ({ registered: () => false }) },
    "./editingview": { registerEditing: () => ({ registered: () => false }) },
    "./driftview": { Drift: class { hotReloadState() { return {}; } } },
    "./assisttools": { registerAssistTools: () => ({ registered: () => [] }) },
    "./chat": { registerChat: () => ({ registered: () => false }) },
    "./qsqldraft": { registerQsqlDraft() {} },
    "./interpreterview": { Interpreters: class { status() { return undefined; } } },
    "./taskprovider": { registerTasks: () => ({ registered: () => false }) },
    "./devcontainerview": { registerDevContainer() {} },
    "./replview": { registerRepl: () => ({}) },
    "./interactiveview": { registerInteractive: () => ({}) },
    "./viewhelpers": { registerViewHelpers: () => ({}) },
    "./temporalview": { registerTemporal: () => ({ registered: () => false }) },
    "./pasteview": { registerPaste() {} },
    "./helpview": { registerHelp: () => ({ hoverRegistered: () => false }) },
    "./cheatsheetview": { registerCheatSheet: () => ({ view: () => undefined }) },
    "./plotsview": { PlotsView: class { registered() { return false; } } },
    "./snapshotview": { registerSnapshots() {} },
    "./teststubview": { registerTestStubs: () => ({ registered: () => false }) },
    "./backtraceview": { registerBacktraceLinks: () => ({ registered: () => false }) },
    "./logpointview": { registerLogpoints: () => ({ logged: () => ({}), marked: () => [] }) },
    "./localsview": { registerLocalsAtError: () => ({ last: () => undefined, failure: () => undefined }) },
    "./editorassistview": { registerArgumentSlot: () => ({ registered: () => true }), registerProcessSymbols: () => ({ registered: () => false }) },
    "./linetimingsview": { registerLineTimings: () => ({ registered: () => false }) },
    "./profileview": { registerFunctionProfile: () => ({ panelOpen: () => false }) },
    "./formatchangedview": { registerFormatChanged: () => ({ registered: () => false }) },
    "./organiseloads": { registerOrganiseLoads() {} },
    "./problemsview": { registerProblemsDashboard: (_c, linter) => ((world.linter = linter), { panelOpen: () => false }) },
    "./dbtoolsview": { registerDbTools: () => ({ state: {}, registered: () => [] }) },
    "./dashboardview": { Dashboards: class {} },
    "./tplogview": { TickerplantLog: class {} },
    "./logview": { LogViewer: class { state() { return undefined; } } },
    "./processadmin": { registerProcessAdmin: () => ({}) },
    "./processtoolsview": { registerProcessTools: () => ({}) },
    "./qsqltools": { registerQsqlTools() {} },
    "./errorexplainview": { registerErrorExplainer: () => ({ registered: () => false }) },
    "./baselineview": { registerBaseline: (_c, linter) => void (world.baseline = linter) },
    "./deadcodeview": { registerDeadCode() {} },
    "./namespaceview": { registerNamespaces: () => ({ registered: () => false, serverChanged() {} }) },
    "./affectedonsave": { registerAffectedOnSave: () => ({ registered: () => false }) },
    "./sqlview": { registerSql: () => ({ registered: () => false }) },
  };
  const file = require.resolve("../out/extension.js");
  delete require.cache[file];
  const original = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request in stubs && (request === "vscode" || request.startsWith("vscode-") || parent?.filename === file)) {
      return stubs[request];
    }
    return original.call(this, request, parent, ...rest);
  };
  try {
    world.extension = require(file);
  } finally {
    Module._load = original;
  }
  world.context = { subscriptions: [], extensionPath };
  return world;
}

test("a server that never answers initialize does not hold up activation or Restart Server", async () => {
  const w = load({ settings: { serverPath: "/opt/hangs" }, behaviour: () => "hang" });
  if (w.extension.timing) w.extension.timing.start = 300;
  const activated = await within(w.extension.activate(w.context), 1000);
  assert.notStrictEqual(activated, "still waiting", "activation waited on the server");
  // Given up on, and said so; then a restart gets a server of its own.
  await sleep(600);
  assert.strictEqual(w.clients[0].stopped, true, "the hung server was left running");
  assert.match(w.errors.join("\n"), /did not answer/);
  const restarted = await within(w.commands["q-lint.restartServer"](), 1500);
  assert.notStrictEqual(restarted, "still waiting", "Restart Server queued behind the hung start");
  assert.strictEqual(w.clients.length, 2);
  await w.extension.deactivate();
});

test("a bundled server that cannot run falls back to PATH without an error", { skip: process.platform === "win32" && "a shell script" }, async (t) => {
  // A package built on another platform carries a binary this one cannot
  // execute. PATH's server then runs, and nothing failed that the user must
  // hear about.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-ext-"));
  fs.mkdirSync(path.join(dir, "server"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "server", "qlinter"), "#!/bin/sh\nexit 126\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "qlinter"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = path.join(dir, "bin");
  t.after(() => (process.env.PATH = PATH));
  const bundled = path.join(dir, "server", "qlinter");
  const w = load({ extensionPath: dir, behaviour: (command) => (command === bundled ? "fail" : "ok") });
  await w.extension.activate(w.context);
  await sleep(100);
  assert.deepStrictEqual(w.started, [path.join(dir, "bin", "qlinter")]);
  // The dashboard and the baseline run the one that started, not the
  // bundled one (#1608).
  assert.strictEqual(w.linter().command, path.join(dir, "bin", "qlinter"));
  assert.strictEqual(w.baseline().command, path.join(dir, "bin", "qlinter"));
  assert.deepStrictEqual(w.errors, []);
  await w.extension.deactivate();
});

test("on Windows a bare qlinter is looked for on PATH, never in the workspace folder", async (t) => {
  // libuv tries a bare name in the directory it starts it in before PATH,
  // and the dashboard and baseline start qlinter in the workspace folder: a
  // qlinter.exe checked in there would run (#1251). With PATH holding none,
  // nothing is started, and the error says qlinter is not on PATH.
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const PATH = process.env.PATH;
  Object.defineProperty(process, "platform", { value: "win32" });
  process.env.PATH = ".;bin";
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    process.env.PATH = PATH;
  });
  const w = load();
  await w.extension.activate(w.context);
  await sleep(100);
  assert.deepStrictEqual(w.started, []);
  assert.strictEqual(w.clients.length, 0);
  assert.match(w.errors.join("\n"), /could not start "qlinter"\..*qlinter is not on PATH\./);
  assert.strictEqual(w.linter().command, undefined);
  assert.strictEqual(w.baseline().command, undefined);
  await w.extension.deactivate();
});

test("off Windows too, PATH holding no qlinter is said, not run as a bare name (#1611)", { skip: process.platform === "win32" && "POSIX PATH" }, async (t) => {
  const PATH = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-nopath-"));
  t.after(() => (process.env.PATH = PATH));
  const w = load();
  await w.extension.activate(w.context);
  await sleep(100);
  assert.deepStrictEqual(w.started, []);
  assert.match(w.errors.join("\n"), /qlinter is not on PATH\./);
  assert.strictEqual(w.linter().command, undefined);
  assert.strictEqual(w.baseline().command, undefined);
  await w.extension.deactivate();
});

test("the error for a serverPath that will not start is about that setting", async () => {
  const w = load({ settings: { serverPath: "/opt/missing/qlinter" }, behaviour: () => "fail" });
  await w.extension.activate(w.context);
  await sleep(100);
  const error = w.errors[w.errors.length - 1];
  assert.match(error, /\/opt\/missing\/qlinter/);
  assert.match(error, /q-lint\.serverPath/);
  // Not the advice for a missing bundled server: the user already set it.
  assert.doesNotMatch(error, /No server for|set q-lint\.serverPath/);
  await w.extension.deactivate();
});

test("Restart Server says why it starts nothing when the server is turned off", async () => {
  const w = load({ settings: { enable: false } });
  await w.extension.activate(w.context);
  await w.commands["q-lint.restartServer"]();
  assert.strictEqual(w.clients.length, 0);
  assert.match(w.infos.join("\n"), /q-lint\.enable/);
  await w.extension.deactivate();
});

test("a Run lens's command sends its code as a query from its document", async () => {
  const w = load();
  await w.extension.activate(w.context);
  const run = w.commands[w.extension.RUN_DEFINITION];
  assert.strictEqual(w.extension.RUN_DEFINITION, "q-lint.runDefinition");
  await run("\\d .qt\ntest_a:{[] 1}\n\\d .\n.qt.test_a[]", "file:///ws/suite.q");
  assert.deepStrictEqual(w.queried, [["\\d .qt\ntest_a:{[] 1}\n\\d .\n.qt.test_a[]", { parsed: "file:///ws/suite.q" }]]);
  // Anything else - run by hand from a keybinding with no arguments - is
  // nothing to send.
  await run();
  await run(1, "file:///ws/suite.q");
  assert.strictEqual(w.queried.length, 1);
  await w.extension.deactivate();
});

test("with code lenses turned off, a lens's command says so and sends nothing", async () => {
  const w = load({ settings: { "codeLens.enable": false } });
  await w.extension.activate(w.context);
  await w.commands[w.extension.RUN_DEFINITION]("f:{x}", "file:///ws/a.q");
  assert.deepStrictEqual(w.queried, []);
  assert.match(w.infos.join("\n"), /turned off \(q-lint\.codeLens\.enable\)/);
  await w.extension.deactivate();
});

test("a reference count lens's command opens the references at its position", async () => {
  const w = load();
  await w.extension.activate(w.context);
  await w.commands["q-lint.showReferences"]("file:///ws/lib.q", { line: 3, character: 0 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.executed)), [
    ["vscode.executeReferenceProvider", { parsed: "file:///ws/lib.q" }, { line: 3, character: 0 }],
    ["editor.action.showReferences", { parsed: "file:///ws/lib.q" }, { line: 3, character: 0 }, [{ ref: 1 }]],
  ]);
  // Anything else is nothing to open.
  await w.commands["q-lint.showReferences"]();
  await w.commands["q-lint.showReferences"]("file:///ws/lib.q", { line: -1, character: 0 });
  assert.strictEqual(w.executed.length, 2);
  await w.extension.deactivate();
});

test("with reference lenses turned off, a lens's command says so and opens nothing", async () => {
  const w = load({ settings: { "referenceLens.enable": false } });
  await w.extension.activate(w.context);
  await w.commands["q-lint.showReferences"]("file:///ws/lib.q", { line: 3, character: 0 });
  assert.deepStrictEqual(w.executed, []);
  assert.match(w.infos.join("\n"), /turned off \(q-lint\.referenceLens\.enable\)/);
  await w.extension.deactivate();
});
