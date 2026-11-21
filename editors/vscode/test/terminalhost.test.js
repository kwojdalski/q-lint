// The q terminals' VS Code side (QTerminals in src/live.ts): which terminal
// code goes to, what starts q, and what Run Code from Terminal closes. Run
// after `tsc`, under a stand-in for the `vscode` module; nothing here starts
// a shell or a q.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

/// A stand-in `vscode`: settings from `config`, files from `files`.
function fakeVscode(config = {}, files = {}) {
  const terminals = [];
  const closed = [];
  const messages = [];
  const disposable = { dispose() {} };
  class Uri {
    constructor(p, scheme = "file") {
      this.path = p;
      this.fsPath = p;
      this.scheme = scheme;
    }
    static file(p) {
      return new Uri(p);
    }
    toString() {
      return `${this.scheme}:${this.path}`;
    }
  }
  const folder = { uri: Uri.file("/ws"), name: "ws", index: 0 };
  const fire = (terminal) => closed.forEach((f) => f(terminal));
  const document = (file, text) => ({
    uri: Uri.file(file),
    isDirty: false,
    save: async () => true,
    getText: () => text,
    lineAt: (n) => ({ text: text.split("\n")[n] }),
  });
  const vscode = new Proxy(
    {
      Uri,
      env: { shell: "/bin/zsh" },
      window: {
        activeTextEditor: undefined,
        createTerminal: (options) => {
          const terminal = {
            name: options.name,
            cwd: options.cwd,
            sent: [],
            disposed: false,
            show() {},
            sendText(text) {
              if (terminal.disposed) throw new Error("Terminal has already been disposed");
              terminal.sent.push(text);
            },
            dispose() {
              terminal.disposed = true;
              // VS Code tells of the close later, not in the call.
              setImmediate(() => fire(terminal));
            },
          };
          terminals.push(terminal);
          return terminal;
        },
        onDidCloseTerminal: (f) => {
          closed.push(f);
          return disposable;
        },
        showInformationMessage: async (m) => void messages.push(m),
        showWarningMessage: async (m) => void messages.push(m),
        showErrorMessage: async (m) => void messages.push(m),
      },
      workspace: {
        workspaceFolders: [folder],
        getWorkspaceFolder: (uri) => (uri.path.startsWith("/ws/") ? folder : undefined),
        getConfiguration: () => ({ get: (key, fallback) => (key in config ? config[key] : fallback) }),
        fs: {
          readFile: async (uri) => {
            await new Promise((r) => setTimeout(r, 5));
            if (!(uri.fsPath in files)) throw new Error(`ENOENT: no such file, open '${uri.fsPath}'`);
            return Buffer.from(files[uri.fsPath]);
          },
        },
      },
    },
    { get: (t, k) => (k in t ? t[k] : (t[k] = class {})) },
  );
  return { vscode, terminals, messages, document, close: (t) => t.dispose() };
}

/// QTerminals loaded against `fake`.
function load(fake) {
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
    const { QTerminals } = require("../out/live.js");
    return new QTerminals({ subscriptions: [] });
  } finally {
    Module._load = load;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("a q binary and an env file under ~ are read from the home directory", async () => {
  const home = os.homedir();
  const fake = fakeVscode(
    { "terminal.qBinary": "~/q/m64/q", "terminal.envPath": "~/.qlint-env" },
    { [path.join(home, ".qlint-env")]: "QHOME=/opt/q\n" },
  );
  const terminals = load(fake);
  fake.vscode.window.activeTextEditor = { document: fake.document("/ws/a.q", "1+1") };
  await terminals.repl();
  assert.deepStrictEqual(fake.messages, []);
  assert.strictEqual(fake.terminals.length, 1);
  assert.strictEqual(fake.terminals[0].sent[0], `QHOME=/opt/q ${path.join(home, "q/m64/q")}`);
});

test("with the last q terminal closed, code goes to a q terminal still open, not a new one", async () => {
  const fake = fakeVscode();
  const terminals = load(fake);
  fake.vscode.window.activeTextEditor = { document: fake.document("/ws/a.q", "1+1"), selection: { active: { line: 0 }, isEmpty: true } };
  await terminals.repl();
  await terminals.runFile();
  assert.deepStrictEqual(fake.terminals.map((t) => t.name), ["q", "a.q"]);
  fake.close(fake.terminals[1]);
  await tick();
  await terminals.send("line");
  assert.strictEqual(fake.terminals.length, 2, "no third terminal is started");
  assert.deepStrictEqual(fake.terminals[0].sent.slice(1), ["1+1"]);
});

test("Run Code from Terminal keeps the file's running terminal when the new one cannot start", async () => {
  const files = { "/ws/.env": "QHOME=/opt/q\n" };
  const fake = fakeVscode({ "terminal.envPath": ".env" }, files);
  const terminals = load(fake);
  fake.vscode.window.activeTextEditor = { document: fake.document("/ws/a.q", "1+1") };
  await terminals.runFile();
  delete files["/ws/.env"];
  await terminals.runFile();
  assert.match(fake.messages.join("\n"), /could not read the env file/);
  assert.strictEqual(fake.terminals.length, 1);
  assert.strictEqual(fake.terminals[0].disposed, false);
});

test("two sends at once with no q terminal start one, and both reach it", async () => {
  const fake = fakeVscode({ "terminal.envPath": ".env" }, { "/ws/.env": "QHOME=/opt/q\n" });
  const terminals = load(fake);
  fake.vscode.window.activeTextEditor = { document: fake.document("/ws/a.q", "1+1"), selection: { active: { line: 0 }, isEmpty: true } };
  await Promise.all([terminals.send("line"), terminals.send("line")]);
  assert.strictEqual(fake.terminals.length, 1);
  assert.deepStrictEqual(fake.terminals[0].sent.slice(1), ["1+1", "1+1"]);
});

test("Run Code from Terminal closes the file's own terminal, not another file's of the same name", async () => {
  const fake = fakeVscode();
  const terminals = load(fake);
  fake.vscode.window.activeTextEditor = { document: fake.document("/ws/a/main.q", "1") };
  await terminals.runFile();
  fake.vscode.window.activeTextEditor = { document: fake.document("/ws/b/main.q", "2") };
  await terminals.runFile();
  assert.deepStrictEqual(fake.terminals.map((t) => [t.name, t.disposed]), [["main.q", false], ["main.q", false]]);
  // Running a/main.q again replaces its own.
  fake.vscode.window.activeTextEditor = { document: fake.document("/ws/a/main.q", "1") };
  await terminals.runFile();
  assert.deepStrictEqual(fake.terminals.map((t) => t.disposed), [true, false, false]);
});
