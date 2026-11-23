// The notebook's VS Code side (src/notebook.ts): the serializer, the kernel
// and Export Notebook, run under a stand-in for the `vscode` module and a
// stand-in for `Live`. Run after `tsc`; nothing here needs an editor or a q.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

/// A stand-in `vscode`, fresh for each test.
function fakeVscode() {
  const disposable = { dispose() {} };
  const messages = [];
  const written = new Map();
  const dialogs = [];
  const registered = { commands: {}, serializer: undefined, controller: undefined };
  class Uri {
    constructor(path, scheme = "file") {
      this.path = path;
      this.fsPath = path;
      this.scheme = scheme;
    }
    static file(p) {
      return new Uri(p);
    }
    static joinPath(base, ...parts) {
      return new Uri([base.path, ...parts].join("/").replace(/\/+/g, "/"), base.scheme);
    }
    with({ path }) {
      return new Uri(path, this.scheme);
    }
    toString() {
      return `${this.scheme}:${this.path}`;
    }
  }
  class NotebookCellData {
    constructor(kind, value, languageId) {
      Object.assign(this, { kind, value, languageId });
    }
  }
  class NotebookData {
    constructor(cells) {
      this.cells = cells;
    }
  }
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
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (l) => (this.listeners.push(l), disposable);
    }
    fire(v) {
      this.listeners.forEach((l) => l(v));
    }
    dispose() {}
  }
  const edits = [];
  const settings = {};
  const warnings = [];
  class WorkspaceEdit {
    set(uri, list) {
      this.uri = uri;
      this.list = list;
    }
  }
  const vscode = {
    Uri,
    EventEmitter,
    WorkspaceEdit,
    NotebookEdit: { updateCellMetadata: (index, metadata) => ({ index, metadata }) },
    NotebookCellData,
    NotebookData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookCellKind: { Markup: 1, Code: 2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand: (id, f) => {
        registered.commands[id] = f;
        return disposable;
      },
    },
    notebooks: {
      createNotebookController: () => {
        const controller = { dispose() {}, createNotebookCellExecution: (cell) => fakeExecution(cell) };
        registered.controller = controller;
        return controller;
      },
      createRendererMessaging: () => ({ onDidReceiveMessage: () => disposable }),
    },
    window: {
      activeNotebookEditor: undefined,
      showInformationMessage: async (m) => void messages.push(m),
      showWarningMessage: async (m, ...rest) => {
        messages.push(m);
        warnings.push(rest);
        return fake.answer;
      },
      withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false }),
      showErrorMessage: async (m) => void messages.push(m),
      showSaveDialog: async (options) => {
        dialogs.push(options);
        return undefined;
      },
      showQuickPick: async () => undefined,
    },
    workspace: {
      workspaceFolders: undefined,
      notebookDocuments: [],
      applyEdit: async (edit) => {
        edits.push(edit);
        return true;
      },
      registerNotebookSerializer: (type, s) => {
        registered.serializer = s;
        return disposable;
      },
      getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback), inspect: () => ({}), update: async () => {} }),
      fs: {
        readFile: async (uri) => {
          if (!written.has(uri.path)) throw new Error(`ENOENT: ${uri.path}`);
          return written.get(uri.path);
        },
        writeFile: async (uri, data) => {
          if (uri.path.startsWith("/readonly/")) throw new Error(`EROFS: read-only file system, open '${uri.path}'`);
          written.set(uri.path, Buffer.from(data));
        },
      },
    },
  };
  const fake = { vscode, messages, written, registered, dialogs, edits, settings, warnings, answer: undefined };
  return fake;
}

/// A cell execution that records what the kernel did with it.
function fakeExecution(cell) {
  const cancel = [];
  const execution = {
    cell,
    log: [],
    outputs: [],
    token: {
      isCancellationRequested: false,
      onCancellationRequested(f) {
        cancel.push(f);
        return { dispose() {} };
      },
    },
    cancel() {
      execution.token.isCancellationRequested = true;
      cancel.forEach((f) => f());
    },
    start(at) {
      execution.log.push("start");
    },
    end(success) {
      execution.log.push(`end ${success}`);
      execution.success = success;
    },
    async clearOutput() {
      execution.outputs = [];
    },
    async replaceOutput(outputs) {
      execution.outputs = outputs;
    },
  };
  return execution;
}

/// `src/notebook.ts` loaded against `fake`, registered with `live`.
function load(fake, live = {}) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "vscode" ? fake.vscode : load.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (/[\\/]out[\\/]/.test(key)) {
        delete require.cache[key];
      }
    }
    const { registerNotebooks } = require("../out/notebook.js");
    return registerNotebooks({ subscriptions: [] }, live);
  } finally {
    Module._load = load;
  }
}

const NOTEBOOK = JSON.stringify({ qnb: 1, cells: [{ kind: "code", source: ["1+1"] }] });

test("Export Notebook to a place it cannot write says so, instead of failing the command", async () => {
  const fake = fakeVscode();
  load(fake);
  fake.written.set("/ws/a.qnb", Buffer.from(NOTEBOOK));
  const exported = fake.registered.commands["q-lint.exportNotebook"](fake.vscode.Uri.file("/ws/a.qnb"), fake.vscode.Uri.file("/readonly/a.q"));
  await assert.doesNotReject(exported);
  assert.match(fake.messages.join("\n"), /could not write \/readonly\/a\.q: EROFS/);
  // A target it can write is written.
  await fake.registered.commands["q-lint.exportNotebook"](fake.vscode.Uri.file("/ws/a.qnb"), fake.vscode.Uri.file("/ws/a.q"));
  assert.match(fake.written.get("/ws/a.q").toString(), /^1\+1$/m);
});

test("Export Notebook of an untitled notebook offers to save the script on disk, not as another untitled file", async () => {
  const fake = fakeVscode();
  load(fake);
  // As New q Notebook opens one: `untitled:Untitled-1.qnb`, never saved.
  const uri = new fake.vscode.Uri("Untitled-1.qnb", "untitled");
  const notebook = { uri, notebookType: "q-lint-notebook", getCells: () => [{ kind: 2, document: { getText: () => "til 3", languageId: "q" } }] };
  fake.vscode.workspace.notebookDocuments.push(notebook);
  fake.vscode.window.activeNotebookEditor = { notebook };
  fake.vscode.workspace.workspaceFolders = [{ uri: fake.vscode.Uri.file("/ws") }];
  await fake.registered.commands["q-lint.exportNotebook"]();
  assert.strictEqual(fake.dialogs.length, 1, fake.messages.join("\n"));
  const offered = fake.dialogs[0].defaultUri;
  assert.strictEqual(offered.scheme, "file");
  assert.strictEqual(offered.path, "/ws/Untitled-1.q");
  // A target given is written from the open notebook's cells.
  await fake.registered.commands["q-lint.exportNotebook"](undefined, fake.vscode.Uri.file("/ws/u.q"));
  assert.match(fake.written.get("/ws/u.q").toString(), /^til 3$/m);
});

test("Export Notebook takes a q notebook whose extension is in capitals, and offers a script, not the notebook itself", async () => {
  const fake = fakeVscode();
  load(fake);
  // VS Code opens `Prices.QNB` as a q notebook: its file pattern ignores case.
  const uri = fake.vscode.Uri.file("/ws/Prices.QNB");
  const notebook = { uri, notebookType: "q-lint-notebook", getCells: () => [{ kind: 2, document: { getText: () => "til 3", languageId: "q" } }] };
  fake.vscode.workspace.notebookDocuments.push(notebook);
  fake.vscode.window.activeNotebookEditor = { notebook };
  await fake.registered.commands["q-lint.exportNotebook"]();
  assert.strictEqual(fake.dialogs.length, 1, fake.messages.join("\n"));
  assert.strictEqual(fake.dialogs[0].defaultUri.path, "/ws/Prices.q");
  // And from the explorer's context menu, by its URI.
  await fake.registered.commands["q-lint.exportNotebook"](uri, fake.vscode.Uri.file("/ws/p.q"));
  assert.match(fake.written.get("/ws/p.q").toString(), /^til 3$/m);
});

/// A notebook of code cells with `sources`, as the kernel sees it.
function notebookOf(sources) {
  const notebook = { cells: [], getCells: () => notebook.cells };
  notebook.cells = sources.map((source) => ({ notebook, executionSummary: undefined, document: { getText: () => source } }));
  return notebook;
}

/// A stand-in Live whose query for `code` waits until `release(code)`.
function slowLive() {
  const waiting = new Map();
  return {
    release: (code) => waiting.get(code)?.(),
    runOnActive: async (code, query) => {
      await new Promise((resolve) => waiting.set(code, resolve));
      return { process: "p", value: await query({ query: async () => ({ ok: true, type: -7, text: ["1"] }) }) };
    },
    abort: async () => {},
  };
}

test("a cell interrupted while it waits for the cell before it stops waiting at once", async () => {
  const fake = fakeVscode();
  const live = slowLive();
  load(fake, live);
  const executions = [];
  const create = fake.registered.controller.createNotebookCellExecution;
  fake.registered.controller.createNotebookCellExecution = (cell) => {
    const e = create(cell);
    executions.push(e);
    return e;
  };
  const notebook = notebookOf(["system \"sleep 60\"", "2"]);
  const run = fake.registered.controller.executeHandler(notebook.cells, notebook);
  await new Promise((r) => setTimeout(r, 10));
  executions[1].cancel();
  await new Promise((r) => setTimeout(r, 10));
  // The second shows as not run while the first still runs.
  assert.deepStrictEqual(executions[1].log, ["start", "end undefined"]);
  assert.deepStrictEqual(executions[0].log, ["start"]);
  live.release("system \"sleep 60\"");
  await run;
  assert.deepStrictEqual(executions[0].log, ["start", "end true"]);
  assert.deepStrictEqual(executions[1].log, ["start", "end undefined"]);
});

test("a save of what was opened keeps the fields of an output, an item and a run q-lint does not know", () => {
  const fake = fakeVscode();
  load(fake);
  const file = {
    qnb: 1,
    cells: [
      { kind: "markdown", source: ["# a"], language: "markdown" },
      {
        kind: "code",
        source: ["1"],
        execution: { order: 1, success: true, start: 1, end: 2, host: "h" },
        outputs: [{ items: [{ mime: "text/plain", text: "1", note: "n" }], id: "o1" }],
      },
    ],
  };
  const text = JSON.stringify(file, null, 1) + "\n";
  const serializer = fake.registered.serializer;
  const data = serializer.deserializeNotebook(Buffer.from(text));
  assert.strictEqual(Buffer.from(serializer.serializeNotebook(data)).toString(), text);
  // Run again, the cell's new run and outputs carry none of the old ones' fields.
  const cell = data.cells[1];
  cell.executionSummary = { executionOrder: 2, success: true, timing: { startTime: 5, endTime: 6 } };
  cell.outputs = [new fake.vscode.NotebookCellOutput([fake.vscode.NotebookCellOutputItem.text("1")])];
  const saved = JSON.parse(Buffer.from(serializer.serializeNotebook(data)).toString());
  assert.deepStrictEqual(saved.cells[1].execution, { order: 2, success: true, start: 5, end: 6 });
  assert.deepStrictEqual(saved.cells[1].outputs, [{ items: [{ mime: "text/plain", text: "1" }] }]);
});

// VS Code times a run only with both ends, so a run with a `start` and no
// `end` (a cell interrupted mid-run by a crash, or a file another tool
// wrote), or an `end` alone, lost it on the first save of the notebook.
test("a save of what was opened keeps a run's start without its end, or its end alone", () => {
  const fake = fakeVscode();
  load(fake);
  const file = {
    qnb: 1,
    cells: [
      { kind: "code", source: ["1"], execution: { order: 1, success: true, start: 1700000000000 } },
      { kind: "code", source: ["2"], execution: { order: 2, end: 1700000000012, host: "h" } },
    ],
  };
  const text = JSON.stringify(file, null, 1) + "\n";
  const serializer = fake.registered.serializer;
  const data = serializer.deserializeNotebook(Buffer.from(text));
  assert.strictEqual(Buffer.from(serializer.serializeNotebook(data)).toString(), text);
  // Run again, the new run does not take the old one's lone start.
  data.cells[0].executionSummary = { executionOrder: 3, success: true, timing: { startTime: 5, endTime: 6 } };
  const saved = JSON.parse(Buffer.from(serializer.serializeNotebook(data)).toString());
  assert.deepStrictEqual(saved.cells[0].execution, { order: 3, success: true, start: 5, end: 6 });
});

// --- #946-#950: the directives, live values, export and the headless run,
// on and off.

/// A notebook of `cells` ([kind, source]), as the kernel and the commands
/// see it.
function notebookWith(fake, cells, uri = fake.vscode.Uri.file("/ws/n.qnb")) {
  const notebook = { uri, notebookType: "q-lint-notebook", metadata: {}, cells: [], getCells: () => notebook.cells, cellAt: (i) => notebook.cells[i] };
  notebook.cells = cells.map(([kind, source], index) => ({
    notebook,
    index,
    kind: kind === "code" ? 2 : 1,
    metadata: {},
    outputs: [],
    executionSummary: undefined,
    document: { getText: () => source, languageId: kind === "code" ? "q" : "markdown" },
  }));
  return notebook;
}

/// A stand-in Live over saved `processes`, connected to `active`, that
/// records what is connected to and what is sent.
function recordingLive(processes, active) {
  const live = {
    active,
    connected: [],
    sent: [],
    processes: () => processes,
    discovery: { discovered: () => [] },
    activeLabel: () => live.active,
    isBusy: () => false,
    connectTo: async (label) => {
      live.connected.push(label);
      live.active = label;
      return true;
    },
    runOnActive: async (code, query) => {
      live.sent.push(code);
      const connection = {
        query: async (cut) => ({ ok: true, type: -7, text: [`${live.active}: ${cut.join(";")}`] }),
        call: async (lambda, arg) => {
          live.sent.push(lambda.startsWith("{[es]") ? `live ${arg.join(",")}` : "call");
          return lambda.startsWith("{[es]") ? arg.map((e) => [true, `<${e}>`]) : { ok: true, table: false, type: -7, text: ["1"] };
        },
      };
      return { process: live.active, value: await query(connection) };
    },
    abort: async () => {},
  };
  return live;
}

const PROCESSES = [
  { label: "dev1", host: "h", port: 1, tags: ["dev"] },
  { label: "prod1", host: "h", port: 2, tags: ["prod"] },
];

/// Run `cells` of `notebook` through the kernel; their executions.
async function runCells(fake, notebook, indexes) {
  const executions = [];
  const create = fake.registered.controller.createNotebookCellExecution;
  fake.registered.controller.createNotebookCellExecution = (cell) => {
    const e = create(cell);
    executions.push(e);
    return e;
  };
  await fake.registered.controller.executeHandler(indexes.map((i) => notebook.cells[i]), notebook);
  return executions;
}
const outputText = (e) => e.outputs.flatMap((o) => o.items.map((i) => Buffer.from(i.data).toString("utf8"))).join("\n");

test("/ @process connects to the process it names before the cell runs, and the cell runs there", async () => {
  const fake = fakeVscode();
  const live = recordingLive(PROCESSES, "other");
  load(fake, live);
  const notebook = notebookWith(fake, [["code", "/ @process dev1\n1+1"], ["code", "/ @process nope\n1"]]);
  const [first, second] = await runCells(fake, notebook, [0, 1]);
  assert.deepStrictEqual(live.connected, ["dev1"]);
  assert.match(outputText(first), /^dev1: 1\+1$/);
  assert.strictEqual(first.success, true);
  assert.strictEqual(second.success, false);
  assert.match(outputText(second), /No q process is labelled \\"nope\\"/);
});

test("/ @process to a production process asks first, and runs nothing unless confirmed", async () => {
  const fake = fakeVscode();
  const live = recordingLive(PROCESSES, "dev1");
  load(fake, live);
  const notebook = notebookWith(fake, [["code", "/ @process prod1\n1"]]);
  const [refused] = await runCells(fake, notebook, [0]);
  assert.deepStrictEqual(live.connected, []);
  assert.deepStrictEqual(live.sent, []);
  assert.match(fake.messages.join("\n"), /prod1 is a production process \(tagged prod\)/);
  assert.deepStrictEqual(fake.warnings[0][0].modal, true);
  assert.match(outputText(refused), /not confirmed/);
  fake.answer = "Connect and Run";
  const [ran] = await runCells(fake, notebook, [0]);
  assert.deepStrictEqual(live.connected, ["prod1"]);
  assert.strictEqual(ran.success, true);
});

test("with q-lint.notebook.processDirective.enable off, a / @process cell is refused and nothing is sent", async () => {
  const fake = fakeVscode();
  fake.settings["notebook.processDirective.enable"] = false;
  const live = recordingLive(PROCESSES, "other");
  load(fake, live);
  const [e] = await runCells(fake, notebookWith(fake, [["code", "/ @process dev1\n1"]]), [0]);
  assert.strictEqual(e.success, false);
  assert.match(outputText(e), /q-lint\.notebook\.processDirective\.enable/);
  assert.deepStrictEqual(live.connected, []);
  assert.deepStrictEqual(live.sent, []);
});

test("with q-lint.notebook.parameters.enable off, a / @parameters cell is refused", async () => {
  const fake = fakeVscode();
  fake.settings["notebook.parameters.enable"] = false;
  const live = recordingLive(PROCESSES, "dev1");
  load(fake, live);
  const [e] = await runCells(fake, notebookWith(fake, [["code", "/ @parameters\nn:1"]]), [0]);
  assert.strictEqual(e.success, false);
  assert.match(outputText(e), /Run Notebook with Parameters is turned off/);
  assert.deepStrictEqual(live.sent, []);
});

test("a code cell that runs reads the live values of the Markdown after it into their metadata, not their source", async () => {
  const fake = fakeVscode();
  const live = recordingLive(PROCESSES, "dev1");
  const api = load(fake, live);
  const notebook = notebookWith(fake, [["markdown", "top {{q: a}}"], ["code", "a:1"], ["markdown", "a is {{q: a}} and {{q: b}}"], ["code", "2"], ["markdown", "{{q: c}}"]]);
  await runCells(fake, notebook, [1]);
  // What the guard reads is the cell and the expressions sent after it (#1088).
  assert.deepStrictEqual(live.sent, ["a:1\na\nb", "live a,b"]);
  assert.deepStrictEqual(fake.edits[0].list, [
    { index: 0, metadata: { "q-lint.liveValues": { a: { text: "<a>" } } } },
    { index: 2, metadata: { "q-lint.liveValues": { a: { text: "<a>" }, b: { text: "<b>" } } } },
  ]);
  assert.strictEqual(api.processOf(notebook), "dev1");
  // Off: the cell runs, and no expression is sent.
  fake.settings["notebook.liveValues.enable"] = false;
  live.sent = [];
  await runCells(fake, notebook, [1]);
  assert.deepStrictEqual(live.sent, ["a:1"]);
  assert.strictEqual(fake.edits.length, 1);
});

test("Export as HTML and as Jupyter write the notebook with its outputs; off, they refuse and write nothing", async () => {
  const fake = fakeVscode();
  load(fake);
  fake.written.set(
    "/ws/a.qnb",
    Buffer.from(JSON.stringify({ qnb: 1, cells: [{ kind: "code", source: ["\"<b>\""], execution: { order: 1 }, outputs: [{ items: [{ mime: "text/plain", text: "\"<b>\"" }] }] }] })),
  );
  const { Uri } = fake.vscode;
  await fake.registered.commands["q-lint.exportNotebookHtml"](Uri.file("/ws/a.qnb"), Uri.file("/ws/a.html"));
  assert.match(fake.written.get("/ws/a.html").toString(), /<pre class="out">&quot;&lt;b&gt;&quot;<\/pre>/);
  await fake.registered.commands["q-lint.exportNotebookIpynb"](Uri.file("/ws/a.qnb"), Uri.file("/ws/a.ipynb"));
  assert.strictEqual(JSON.parse(fake.written.get("/ws/a.ipynb").toString()).cells[0].execution_count, 1);
  await fake.registered.commands["q-lint.importIpynb"](Uri.file("/ws/a.ipynb"), Uri.file("/ws/b.qnb"));
  assert.strictEqual(JSON.parse(fake.written.get("/ws/b.qnb").toString()).cells[0].source[0], "\"<b>\"");
  fake.settings["notebook.export.enable"] = false;
  for (const [command, out] of [["q-lint.exportNotebookHtml", "/ws/c.html"], ["q-lint.exportNotebookIpynb", "/ws/c.ipynb"], ["q-lint.importIpynb", "/ws/c.qnb"]]) {
    await fake.registered.commands[command](Uri.file(command.endsWith("Ipynb") && command.startsWith("q-lint.import") ? "/ws/a.ipynb" : "/ws/a.qnb"), Uri.file(out));
    assert.strictEqual(fake.written.has(out), false, command);
  }
  assert.match(fake.messages.at(-1), /set q-lint\.notebook\.export\.enable to true/);
});

/// `src/notebookrun.ts` loaded against `fake`, beside `src/notebook.ts`.
function loadRun(fake, live) {
  load(fake, live);
  const original = Module._load;
  Module._load = function (request, ...rest) {
    return request === "vscode" ? fake.vscode : original.call(this, request, ...rest);
  };
  try {
    return require("../out/notebookrun.js");
  } finally {
    Module._load = original;
  }
}

test("Run Notebook with Parameters runs the notebook on the active connection and writes the run; off, it refuses", async () => {
  const fake = fakeVscode();
  const live = recordingLive(PROCESSES, "dev1");
  const { runWithParameters } = loadRun(fake, live);
  const { Uri } = fake.vscode;
  fake.written.set("/ws/p.qnb", Buffer.from(JSON.stringify({ qnb: 1, cells: [{ kind: "code", source: ["/ @parameters", "n:1"] }, { kind: "code", source: ["n"] }] })));
  const result = await runWithParameters(live, Uri.file("/ws/p.qnb"), Uri.file("/ws/p-run.qnb"), { n: "7" });
  assert.strictEqual(result.failed, undefined);
  assert.deepStrictEqual(live.sent, ["/ @parameters\nn:1", "/ Parameters given to this run.\nn:7;", "n"]);
  const written = JSON.parse(fake.written.get("/ws/p-run.qnb").toString());
  assert.deepStrictEqual(written.cells[1].source, ["/ Parameters given to this run.", "n:7;"]);
  assert.strictEqual(written.cells[2].outputs[0].items[0].text, "dev1: n");
  fake.settings["notebook.parameters.enable"] = false;
  live.sent = [];
  assert.strictEqual(await runWithParameters(live, Uri.file("/ws/p.qnb"), Uri.file("/ws/p-off.qnb"), {}), undefined);
  assert.deepStrictEqual(live.sent, []);
  assert.strictEqual(fake.written.has("/ws/p-off.qnb"), false);
  assert.match(fake.messages.at(-1), /q-lint\.notebook\.parameters\.enable/);
});
