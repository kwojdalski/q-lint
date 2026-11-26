// A stand-in for the `vscode` module, so node can drive the classes that
// import it (#901): `Live`, `DiscoveryServers`, `ProcessExplorer`. Anything
// not defined here is a no-op that returns another no-op. What a test needs
// to see or script - input boxes, quick picks, messages, configuration,
// registered commands, tree views - is kept on `stub` for it to read or set.
// Require this before anything from `out/` that imports `vscode`.
const Module = require("node:module");

/// A function that is also an object: any property is another one, calling
/// or constructing it gives another one. Not thenable, so `await` passes it.
function anything() {
  const target = function () {};
  return new Proxy(target, {
    get: (t, key) => {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (!(key in t)) t[key] = anything();
      return t[key];
    },
    set: (t, key, value) => {
      t[key] = value;
      return true;
    },
    apply: () => anything(),
    construct: () => anything(),
  });
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
    };
  }
  fire(value) {
    for (const l of [...this.listeners]) l(value);
  }
  dispose() {
    this.listeners = [];
  }
}

class Disposable {
  constructor(f) {
    this.dispose = f ?? (() => {});
  }
}

const stub = {
  /// Answers for input boxes and quick picks, taken in order; a function is
  /// called with the options. Undefined when none is left: the user pressed
  /// Escape.
  inputs: [],
  picks: [],
  messages: [],
  /// Settings as `section.key` (without `q-lint.`): what `get` returns, and
  /// where `update` writes, per target.
  config: { user: {}, workspace: {} },
  updates: [],
  commands: new Map(),
  trees: [],
  configListeners: [],
  context: undefined,
  reset() {
    this.inputs = [];
    this.picks = [];
    this.messages = [];
    this.config = { user: {}, workspace: {} };
    this.updates = [];
    this.commands = new Map();
    this.trees = [];
    this.configListeners = [];
  },
  /// An ExtensionContext with globalState and secrets in memory.
  newContext() {
    const state = new Map();
    const secrets = new Map();
    return {
      subscriptions: [],
      globalState: {
        get: (k, d) => (state.has(k) ? structuredClone(state.get(k)) : d),
        update: async (k, v) => void state.set(k, structuredClone(v)),
        keys: () => [...state.keys()],
      },
      workspaceState: { get: (k, d) => d, update: async () => {}, keys: () => [] },
      secrets: {
        store: async (k, v) => void secrets.set(k, v),
        get: async (k) => secrets.get(k),
        delete: async (k) => void secrets.delete(k),
        onDidChange: () => new Disposable(),
        all: secrets,
      },
      extensionUri: anything(),
      extensionPath: "/",
      asAbsolutePath: (p) => p,
      storageUri: undefined,
      globalStorageUri: anything(),
    };
  },
  /// Fire a configuration change for `key` (`q-lint.x.y`).
  changeConfig(key) {
    const event = { affectsConfiguration: (s) => key === s || key.startsWith(`${s}.`) };
    for (const l of [...this.configListeners]) l(event);
  },
};

const take = (list, options) => {
  const next = list.shift();
  return typeof next === "function" ? next(options) : next;
};

const window = new Proxy(
  {
    showInputBox: async (options) => take(stub.inputs, options),
    showQuickPick: async (items, options) => {
      const all = await items;
      const answer = take(stub.picks, { items: all, ...options });
      return typeof answer === "string" ? all.find((i) => (typeof i === "string" ? i : i.label) === answer) : answer;
    },
    showInformationMessage: async (text, ...rest) => (stub.messages.push(["info", text]), take(stub.picks, { message: text, items: rest })),
    showWarningMessage: async (text, ...rest) => (stub.messages.push(["warning", text]), take(stub.picks, { message: text, items: rest })),
    showErrorMessage: async (text) => void stub.messages.push(["error", text]),
    createTreeView: (id, options) => {
      const view = { id, options, message: undefined, description: undefined, badge: undefined, selection: [], visible: true, disposed: false, dispose() { this.disposed = true; }, reveal: async () => {}, onDidChangeVisibility: () => new Disposable() };
      stub.trees.push(view);
      return view;
    },
    registerTreeDataProvider: () => new Disposable(),
    withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
  },
  { get: (t, key) => (key in t ? t[key] : (t[key] = anything())) },
);

const configuration = (section) => ({
  get: (key, fallback) => {
    const full = section ? `${section}.${key}`.replace(/^q-lint\./, "") : key;
    if (full in stub.config.workspace) return stub.config.workspace[full];
    if (full in stub.config.user) return stub.config.user[full];
    return fallback;
  },
  inspect: (key) => {
    const full = section ? `${section}.${key}`.replace(/^q-lint\./, "") : key;
    return {
      key,
      ...(full in stub.config.user ? { globalValue: stub.config.user[full] } : {}),
      ...(full in stub.config.workspace ? { workspaceValue: stub.config.workspace[full] } : {}),
    };
  },
  update: async (key, value, target) => {
    const full = section ? `${section}.${key}`.replace(/^q-lint\./, "") : key;
    const where = target === 1 || target === true ? "user" : target === 3 ? "workspaceFolder" : "workspace";
    stub.updates.push({ key: full, value, target: where });
    (stub.config[where] ??= {})[full] = value;
    stub.changeConfig(`q-lint.${full}`);
  },
  has: () => false,
});

const workspace = new Proxy(
  {
    getConfiguration: configuration,
    onDidChangeConfiguration: (listener) => {
      stub.configListeners.push(listener);
      return new Disposable(() => (stub.configListeners = stub.configListeners.filter((l) => l !== listener)));
    },
    workspaceFolders: undefined,
    textDocuments: [],
  },
  { get: (t, key) => (key in t ? t[key] : (t[key] = anything())) },
);

const commands = new Proxy(
  {
    registerCommand: (name, run) => {
      stub.commands.set(name, run);
      return new Disposable(() => stub.commands.delete(name));
    },
    executeCommand: async (name, ...args) => (stub.commands.has(name) ? stub.commands.get(name)(...args) : undefined),
  },
  { get: (t, key) => (key in t ? t[key] : (t[key] = anything())) },
);

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = "file";
  }
  static file(p) {
    return new Uri(p);
  }
  static parse(s) {
    return new Uri(s);
  }
  static joinPath(base, ...parts) {
    return new Uri([base.fsPath, ...parts].join("/"));
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class MarkdownString {
  constructor(value = "") {
    this.value = value;
  }
  appendMarkdown(v) {
    this.value += v;
    return this;
  }
  appendText(v) {
    this.value += v;
    return this;
  }
  appendCodeblock(v, language) {
    (this.blocks ??= []).push([language, v]);
    this.value += v;
    return this;
  }
}

const vscode = new Proxy(
  {
    EventEmitter,
    Disposable,
    TreeItem,
    MarkdownString,
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    CompletionItemKind: new Proxy({}, { get: (_t, k) => String(k) }),
    window,
    workspace,
    commands,
    Uri,
  },
  { get: (t, key) => (key in t ? t[key] : (t[key] = anything())) },
);

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? "vscode" : resolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };

module.exports = { stub, vscode, EventEmitter };
