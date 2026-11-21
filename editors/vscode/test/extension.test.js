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
  const world = { clients: [], errors: [], infos: [], commands: {}, started: [] };
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
    commands: {
      registerCommand: (name, run) => {
        world.commands[name] = run;
        return { dispose() {} };
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
    "./live": { Live: class { api() { return {}; } processes() { return []; } } },
    "./agenttool": { registerAgentTool: () => () => undefined },
    "./onboardingview": { registerOnboarding() {} },
    "./notebook": { registerNotebooks: () => ({ charts: () => [] }) },
    "./explorerview": { ProcessExplorer: class { rows() { return []; } } },
    "./relate": { Relations: class { serverChanged() {} } },
    "./funcsourceview": { FunctionSources: class { state() { return {}; } } },
    "./infoview": { registerInfoViews: () => ({ monitor: () => [], hdb: () => [] }) },
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

test("a bundled server that cannot run falls back to PATH without an error", { skip: process.platform === "win32" && "a shell script" }, async () => {
  // A package built on another platform carries a binary this one cannot
  // execute. PATH's server then runs, and nothing failed that the user must
  // hear about.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-ext-"));
  fs.mkdirSync(path.join(dir, "server"));
  fs.writeFileSync(path.join(dir, "server", "qlinter"), "#!/bin/sh\nexit 126\n", { mode: 0o755 });
  const bundled = path.join(dir, "server", "qlinter");
  const w = load({ extensionPath: dir, behaviour: (command) => (command === bundled ? "fail" : "ok") });
  await w.extension.activate(w.context);
  await sleep(100);
  assert.deepStrictEqual(w.started, ["qlinter"]);
  assert.deepStrictEqual(w.errors, []);
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
