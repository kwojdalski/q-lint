// Restart Notebook Process and Run All (#1000) through the stand-in
// `vscode` module and the notebook's real kernel: a process q-lint did not
// start is never restarted, one it did is restarted only once the user says
// so, and every q cell then runs from 1. With QLINT_TEST_Q, a real q process
// started by the launcher is restarted, and a write on a process the
// read-only guard holds is not sent.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const vscode = require("vscode");
const pkg = require("../package.json");

const Q = process.env.QLINT_TEST_Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the kernel needs of VS Code's notebook API, recording each cell run.
class NotebookCellOutput {
  constructor(items, metadata) {
    this.items = items;
    this.metadata = metadata;
  }
}
class NotebookCellOutputItem {
  constructor(data, mime) {
    this.data = data;
    this.mime = mime;
  }
  static text(t, mime = "text/plain") {
    return new NotebookCellOutputItem(Buffer.from(t, "utf8"), mime);
  }
  static stderr(t) {
    return NotebookCellOutputItem.text(t, "application/vnd.code.notebook.stderr");
  }
  static error(e) {
    return NotebookCellOutputItem.text(JSON.stringify(e), "application/vnd.code.notebook.error");
  }
}
let executions = [];
function fakeExecution(cell) {
  const execution = {
    cell,
    log: [],
    outputs: [],
    executionOrder: undefined,
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    start: () => execution.log.push("start"),
    end: (success) => (execution.log.push(`end ${success}`), (execution.success = success)),
    clearOutput: async () => (execution.log.push("clear"), (execution.outputs = [])),
    replaceOutput: async (outputs) => void (execution.outputs = outputs),
  };
  executions.push(execution);
  return execution;
}
Object.assign(vscode, {
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookCellKind: { Markup: 1, Code: 2 },
  notebooks: {
    createNotebookController: () => ({ dispose() {}, createNotebookCellExecution: fakeExecution }),
    createRendererMessaging: () => ({ onDidReceiveMessage: () => ({ dispose() {} }) }),
  },
});

const { registerNotebooks } = require("../out/notebook.js");
const { NotebookRestart } = require("../out/notebookrestart.js");
const { Live } = require("../out/live.js");
const { Launcher } = require("../out/launcherview.js");

const text = (execution) => execution.outputs.flatMap((o) => o.items).map((i) => i.data.toString()).join("\n");

/// A notebook of `cells` - `[source, language]` or a source, q - as the kernel sees it.
function notebookOf(cells) {
  const notebook = { uri: vscode.Uri.file("/ws/nb.qnb"), notebookType: "q-lint-notebook", cells: [], getCells: () => notebook.cells };
  notebook.cells = cells.map((c, index) => {
    const [source, language] = Array.isArray(c) ? c : [c, "q"];
    return {
      notebook,
      index,
      kind: language === "markdown" ? 1 : 2,
      executionSummary: { executionOrder: 7 },
      metadata: {},
      document: { getText: () => source, languageId: language },
    };
  });
  return notebook;
}

/// The command over the real kernel, with `live` and `launcher` as given.
function setUp(live, launcher) {
  stub.reset();
  executions = [];
  const context = stub.newContext();
  const kernel = registerNotebooks(context, live);
  const restart = new NotebookRestart(context, live, launcher, kernel);
  return { context, kernel, restart, run: (uri) => stub.commands.get("q-lint.restartNotebookAndRunAll")(uri) };
}

/// A Live standing in for a process `label` that answers each statement.
function fakeLive({ label = "rdb", launched = false, busy = false } = {}) {
  const live = {
    sent: [],
    connected: [],
    activeLabel: () => label,
    isBusy: () => busy,
    launched: () => launched,
    connectTo: async (l) => (live.connected.push(l), true),
    abort: async () => {},
    runOnActive: async (code, query) => {
      live.sent.push(code);
      return {
        process: label,
        value: await query({ query: async (cut) => (cut[0] === "fail" ? { ok: false, error: "fail", trace: "" } : { ok: true, type: -7, text: [`ran ${cut.join(";")}`] }) }),
      };
    },
  };
  return live;
}

const fakeLauncher = (answer) => {
  const launcher = { restarted: [], restart: async (l) => (launcher.restarted.push(l), answer) };
  return launcher;
};

test("a process q-lint did not start is never restarted: asked, Run All runs every q cell from 1", async () => {
  const live = fakeLive();
  const launcher = fakeLauncher();
  const { restart, run } = setUp(live, launcher);
  const notebook = notebookOf(["a:1", ["# md", "markdown"], ["print(1)", "python"], "a+1"]);
  vscode.window.activeNotebookEditor = { notebook };
  // Declined: nothing runs.
  stub.picks.push(undefined);
  await run();
  assert.match(stub.messages.at(-1)[1], /^rdb was not started by q-lint, so q-lint cannot restart it\.$/);
  assert.deepStrictEqual([live.sent, executions.length, restart.last.outcome], [[], 0, "declined"]);
  stub.picks.push("Run All Without Restart");
  await run();
  assert.deepStrictEqual(live.sent, ["a:1", "a+1"]);
  assert.deepStrictEqual(executions.map((e) => [e.executionOrder, e.success, text(e)]), [[1, true, "ran a:1"], [2, true, "ran a+1"]]);
  assert.deepStrictEqual(launcher.restarted, []);
  assert.deepStrictEqual(live.connected, []);
  assert.deepStrictEqual(restart.last, { outcome: "ran", process: "rdb" });
});

test("a fresh run stops at the first failing cell and clears what the cells after it showed", async () => {
  const live = fakeLive();
  const { run } = setUp(live, fakeLauncher());
  const notebook = notebookOf(["fail", "b", "c"]);
  vscode.window.activeNotebookEditor = { notebook };
  stub.picks.push("Run All Without Restart");
  await run();
  assert.deepStrictEqual(live.sent, ["fail"]);
  assert.deepStrictEqual(executions.map((e) => e.success), [false, undefined, undefined]);
  assert.deepStrictEqual(executions[1].log, ["start", "clear", "end undefined"]);
});

test("a process q-lint started is restarted once the user says so, then connected to, then run", async () => {
  const live = fakeLive({ launched: true });
  const launcher = fakeLauncher("it ended before it listened");
  const { restart, run } = setUp(live, launcher);
  const notebook = notebookOf(["x:1", "x"]);
  vscode.workspace.notebookDocuments = [notebook];
  vscode.window.activeNotebookEditor = undefined;
  stub.picks.push(undefined);
  await run(notebook.uri);
  assert.match(stub.messages.at(-1)[1], /^Restart rdb and run all 2 q cells of the notebook\?$/);
  assert.deepStrictEqual([launcher.restarted, live.sent, restart.last.outcome], [[], [], "declined"]);
  // A restart that fails runs nothing.
  stub.picks.push("Restart and Run All");
  await run(notebook.uri);
  assert.deepStrictEqual(launcher.restarted, ["rdb"]);
  assert.match(stub.messages.at(-1)[1], /could not restart rdb: it ended before it listened/);
  assert.deepStrictEqual(live.sent, []);
  launcher.restart = async (l) => (launcher.restarted.push(l), undefined);
  stub.picks.push("Restart and Run All");
  await run(notebook.uri);
  assert.deepStrictEqual(live.connected, ["rdb"]);
  assert.deepStrictEqual(live.sent, ["x:1", "x"]);
  assert.deepStrictEqual(restart.last, { outcome: "restarted", process: "rdb" });
});

test("refused: off, no notebook, no process, a query running; turned on, it works without a reload", async () => {
  const live = fakeLive();
  const launcher = fakeLauncher();
  const { restart, run } = setUp(live, launcher);
  const notebook = notebookOf(["1"]);
  vscode.window.activeNotebookEditor = { notebook };
  stub.config.user["notebook.restartRunAll.enable"] = false;
  stub.picks.push("Run All Without Restart", "Restart and Run All");
  await run();
  assert.strictEqual(stub.messages.at(-1)[1], "q-lint: Restart Notebook Process and Run All is turned off: set q-lint.notebook.restartRunAll.enable to true to turn it on.");
  assert.deepStrictEqual([live.sent, launcher.restarted, restart.last.outcome], [[], [], "refused"]);
  stub.config.user["notebook.restartRunAll.enable"] = true;
  stub.picks = [];
  vscode.window.activeNotebookEditor = undefined;
  await run();
  assert.match(stub.messages.at(-1)[1], /open a q notebook to restart its process/);
  vscode.window.activeNotebookEditor = { notebook };
  live.activeLabel = () => undefined;
  await run();
  assert.match(stub.messages.at(-1)[1], /the notebook has no process yet/);
  live.activeLabel = () => "rdb";
  live.isBusy = () => true;
  await run();
  assert.match(stub.messages.at(-1)[1], /a query is still running on rdb/);
  assert.deepStrictEqual(live.sent, []);
  live.isBusy = () => false;
  stub.picks.push("Run All Without Restart");
  await run();
  assert.deepStrictEqual(live.sent, ["1"]);
});

test("turned off at its question, nothing is restarted or run (#1453)", async () => {
  const off = (answer) => () => {
    stub.config.user["notebook.restartRunAll.enable"] = false;
    return answer;
  };
  for (const [launched, answer] of [[true, "Restart and Run All"], [false, "Run All Without Restart"]]) {
    const live = fakeLive({ launched });
    const launcher = fakeLauncher();
    const { restart, run } = setUp(live, launcher);
    vscode.window.activeNotebookEditor = { notebook: notebookOf(["a:1"]) };
    stub.config.user["notebook.restartRunAll.enable"] = true;
    stub.picks.push(off(answer));
    await run();
    assert.deepStrictEqual([launcher.restarted, live.sent, live.connected, restart.last.outcome], [[], [], [], "refused"]);
    assert.match(stub.messages.at(-1)[1], /restartRunAll\.enable to true/);
  }
});

test("the command is on the notebook's toolbar and the palette, each behind its setting", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: notebook features");
  assert.strictEqual(section.properties["q-lint.notebook.restartRunAll.enable"].default, true);
  assert.strictEqual(pkg.contributes.commands.find((c) => c.command === "q-lint.restartNotebookAndRunAll").category, "q-lint");
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === "q-lint.restartNotebookAndRunAll");
  assert.strictEqual(menus.length, 2);
  for (const m of menus) assert.match(m.when, /config\.q-lint\.notebook\.restartRunAll\.enable/);
});

// --- a real q

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const accepts = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
    s.on("error", () => resolve(false));
  });

/// QLINT_TEST_Q as a launch definition: its program, arguments and environment.
function qLaunch(dir) {
  const words = Q.trim().split(/\s+/);
  if (words[0] === "env") words.shift();
  const env = {};
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const [key, ...value] = words.shift().split("=");
    env[key] = value.join("=");
  }
  return { command: words[0], cwd: dir, ...(words.length > 1 ? { args: words.slice(1) } : {}), env };
}

test("a real q process q-lint started is restarted, its state gone, and the cells run on the new one; a guarded write is held", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  stub.reset();
  executions = [];
  const vs = require("vscode");
  const make = vs.window.createOutputChannel;
  vs.window.createOutputChannel = () => ({ append() {}, appendLine() {}, clear() {}, show() {}, dispose() {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-restart-"));
  const port = await freePort();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "q", host: "127.0.0.1", port, tags: ["ro"], launch: qLaunch(dir) }]);
  // Guarded by a tag of its own, so the guard holds on a local process.
  stub.config.user["processes.readOnlyGuard.tags"] = ["ro"];
  const live = new Live(context);
  const launcher = new Launcher(context, live);
  const kernel = registerNotebooks(context, live);
  const restart = new NotebookRestart(context, live, launcher, kernel);
  t.after(async () => {
    vs.window.createOutputChannel = make;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  await stub.commands.get("q-lint.startProcess")("q");
  for (let i = 0; i < 100 && !(await accepts(port)); i++) await sleep(100);
  assert.ok(await accepts(port));
  const [{ pid: before }] = launcher.running();
  assert.strictEqual(await live.connectTo("q"), true);
  // State the restart must lose: set behind the guard's back, as a reader would not.
  await live.borrow((c) => c.query(["set[`before;42]"], [10, 80]));
  const notebook = notebookOf(["til 3", "@[value;`before;{\"gone\"}]", "x:1"]);
  vs.window.activeNotebookEditor = { notebook };
  // Restart, then the guard asks for `x:1` and is declined.
  stub.picks.push("Restart and Run All", undefined);
  await stub.commands.get("q-lint.restartNotebookAndRunAll")();
  assert.deepStrictEqual(restart.last, { outcome: "restarted", process: "q" }, JSON.stringify(stub.messages));
  const [{ pid: after }] = launcher.running();
  assert.notStrictEqual(after, before);
  assert.deepStrictEqual(executions.map((e) => [e.executionOrder, e.success]), [[1, true], [2, true], [3, false]]);
  assert.strictEqual(text(executions[0]), "0 1 2");
  assert.strictEqual(text(executions[1]), '"gone"');
  assert.match(text(executions[2]), /Not run: changing the read-only process q was not confirmed/);
  assert.ok(stub.messages.some(([kind, m]) => kind === "warning" && /^This code would change q\. Run it anyway\?$/.test(m)), JSON.stringify(stub.messages));
  // Nothing of the held cell reached the process.
  assert.deepStrictEqual((await live.borrow((c) => c.query(["@[value;`x;{\"undefined\"}]"], [10, 80]))).text, ['"undefined"']);
});
