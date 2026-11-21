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
  const vscode = {
    Uri,
    NotebookCellData,
    NotebookData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookCellKind: { Markup: 1, Code: 2 },
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
      showWarningMessage: async (m) => void messages.push(m),
      showErrorMessage: async (m) => void messages.push(m),
      showSaveDialog: async () => undefined,
      showQuickPick: async () => undefined,
    },
    workspace: {
      notebookDocuments: [],
      registerNotebookSerializer: (type, s) => {
        registered.serializer = s;
        return disposable;
      },
      getConfiguration: () => ({ get: (key, fallback) => fallback, inspect: () => ({}), update: async () => {} }),
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
  return { vscode, messages, written, registered };
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
