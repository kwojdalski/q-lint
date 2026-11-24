// `.env` files for q (#976): the file read by the env file's rules with no
// value ever in a message, the split between a terminal's command line and
// its environment, and the variables reaching a q terminal, a launched
// process and the off state - under a stand-in `vscode` module, with a
// node script standing in for q.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { readDotenv, readEnvSettings, namesText, terminalEnv, mergeEnv } = require("../out/qenv.js");

const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));

test("a .env file is read by the env file's rules, and a bad line is named by its number alone", () => {
  const { env, badLines } = readDotenv('# comment\nQHOME=/opt/q\nexport QLIC="/opt/lic"\nAPI_TOKEN=s3cr3t-value\nthis is s3cr3t garbage\n\nEMPTY=\n');
  assert.deepStrictEqual(env, { QHOME: "/opt/q", QLIC: "/opt/lic", API_TOKEN: "s3cr3t-value", EMPTY: "" });
  assert.deepStrictEqual(badLines, [5]);
  assert.strictEqual(namesText(Object.keys(env)), "QHOME, QLIC, API_TOKEN, EMPTY");
  assert.strictEqual(namesText(["A", "B", "C"], 2), "A, B and 1 more");
  assert.deepStrictEqual(readEnvSettings((_k, f) => f), { enabled: true, file: ".env" });
  assert.deepStrictEqual(readEnvSettings((k, f) => (k === "env.file" ? "  " : f)), { enabled: true, file: ".env" });
  assert.strictEqual(props["q-lint.env.enable"].default, true);
  assert.strictEqual(props["q-lint.env.file"].default, ".env");
  assert.strictEqual(props["q-lint.env.file"].scope, "resource");
});

test("a terminal gets the .env file's variables in its environment, never on its command line", () => {
  const { shown, hidden, refs } = terminalEnv({ QHOME: "/k/q", QLIC: "/k" }, { QHOME: "/mine" }, { QLIC: "/env", TOKEN: "t" });
  assert.deepStrictEqual(shown, { QHOME: "/mine" }, "envPath over the layout; a name the .env sets is left off the line");
  // A q variable the .env sets is kept under a name of its own too, which
  // the command line sets it from: a .zshrc's export does not win (#1684).
  assert.deepStrictEqual(hidden, { QLIC: "/env", TOKEN: "t", QLINT_DOTENV_QLIC: "/env" });
  assert.deepStrictEqual(refs, { QLIC: "QLINT_DOTENV_QLIC" });
  assert.deepStrictEqual(terminalEnv({}, { QHOME: "/mine" }, { QHOME: "/env" }).refs, {}, "envPath's QHOME wins, as before");
  assert.deepStrictEqual(mergeEnv({ A: "layout", B: "layout" }, { B: "env", C: "env" }, { C: "own" }), { A: "layout", B: "env", C: "own" });
});

/// A stand-in `vscode` for QTerminals: settings from `config`, files from
/// `files`, terminals and messages kept; one workspace folder, `root`.
function fakeVscode(config = {}, files = {}, root = "/ws") {
  const terminals = [];
  const messages = [];
  class Uri {
    constructor(p) {
      this.path = p;
      this.fsPath = p;
      this.scheme = "file";
    }
    static file(p) {
      return new Uri(p);
    }
  }
  const folder = { uri: Uri.file(root), name: "ws", index: 0 };
  const vscode = new Proxy(
    {
      Uri,
      env: { shell: "/bin/zsh" },
      window: {
        activeTextEditor: { document: { uri: Uri.file(`${root}/a.q`), isDirty: false, save: async () => true, getText: () => "" } },
        createTerminal: (options) => {
          const terminal = { options, sent: [], show() {}, sendText: (t) => terminal.sent.push(t), dispose() {} };
          terminals.push(terminal);
          return terminal;
        },
        onDidCloseTerminal: () => ({ dispose() {} }),
        showInformationMessage: async (m) => void messages.push(m),
        showWarningMessage: async (m) => void messages.push(m),
        showErrorMessage: async (m) => void messages.push(m),
      },
      workspace: {
        workspaceFolders: [folder],
        getWorkspaceFolder: (uri) => (uri.path.startsWith(`${root}/`) ? folder : undefined),
        getConfiguration: () => ({ get: (key, fallback) => (key in config ? config[key] : fallback) }),
        fs: {
          readFile: async (uri) => {
            if (!(uri.fsPath in files)) throw Object.assign(new Error(`ENOENT: ${uri.fsPath}`), { code: "FileNotFound" });
            return Buffer.from(files[uri.fsPath]);
          },
        },
      },
    },
    { get: (t, k) => (k in t ? t[k] : (t[k] = class {})) },
  );
  return { vscode, terminals, messages };
}

function loadTerminals(fake) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "vscode" ? fake.vscode : load.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (/[\\/]out[\\/]/.test(key)) delete require.cache[key];
    }
    const { QTerminals } = require("../out/live.js");
    return new QTerminals({ subscriptions: [] });
  } finally {
    Module._load = load;
  }
}

test("the q REPL gets the workspace's .env in its environment; the command line shows none of it", async () => {
  const fake = fakeVscode({}, { "/ws/.env": "QHOME=/opt/q\nAPI_TOKEN=s3cr3t\nbad s3cr3t line\n" });
  await loadTerminals(fake).repl();
  assert.strictEqual(fake.terminals.length, 1);
  assert.deepStrictEqual(fake.terminals[0].options.env, { QHOME: "/opt/q", API_TOKEN: "s3cr3t", QLINT_DOTENV_QHOME: "/opt/q" });
  assert.strictEqual(fake.terminals[0].sent[0], 'QHOME="$QLINT_DOTENV_QHOME" q');
  assert.deepStrictEqual(fake.messages.length, 1);
  assert.match(fake.messages[0], /skipped line 3 of \/ws\/\.env: not NAME=value\. Used QHOME, API_TOKEN\./);
  assert.doesNotMatch(fake.messages.join("\n"), /s3cr3t/, "no value in any message");
});

test("Run File with Arguments starts its q with the .env file's variables and the picked interpreter's layout", async (t) => {
  // A KDB-X layout, as Select q Interpreter writes it to q-lint.terminal.qBinary.
  const kx = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-kx-"));
  t.after(() => fs.rmSync(kx, { recursive: true, force: true }));
  fs.mkdirSync(path.join(kx, "bin"));
  fs.mkdirSync(path.join(kx, "q"));
  fs.writeFileSync(path.join(kx, "bin", "q"), "");
  fs.writeFileSync(path.join(kx, "kc.lic"), "");
  const binary = path.join(kx, "bin", "q");
  const fake = fakeVscode({ "terminal.qBinary": binary }, { "/ws/.env": "API_TOKEN=s3cr3t\nFEED=live\n" });
  await loadTerminals(fake).runFile({ args: ["-p", "5001", "two words"], input: ["show .z.x"] });
  assert.strictEqual(fake.terminals.length, 1);
  const [terminal] = fake.terminals;
  assert.deepStrictEqual(terminal.options.env, { API_TOKEN: "s3cr3t", FEED: "live" }, "the .env goes in the environment");
  const [line, ...typed] = terminal.sent;
  assert.ok(line.includes(`QHOME=${path.join(kx, "q")}`) && line.includes(`QLIC=${kx}`), line);
  assert.ok(line.endsWith(`${binary} a.q -p 5001 'two words'`), line);
  assert.doesNotMatch(line, /s3cr3t|FEED/, "no .env value on the command line");
  assert.deepStrictEqual(typed, ["show .z.x"]);
  // The interpreter switch off: the picked binary still runs, without the layout.
  const off = fakeVscode({ "terminal.qBinary": binary, "interpreter.enable": false }, { "/ws/.env": "FEED=live\n" });
  await loadTerminals(off).runFile({ args: ["x"], input: [] });
  assert.deepStrictEqual(off.terminals[0].options.env, { FEED: "live" });
  assert.strictEqual(off.terminals[0].sent[0], `${binary} a.q x`);
});

test("a workspace-relative KDB-X qBinary gets its layout's QHOME and QLIC in a terminal, as in the launcher (#1839)", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-kxrel-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, "kx", "bin"), { recursive: true });
  fs.mkdirSync(path.join(ws, "kx", "q"));
  fs.writeFileSync(path.join(ws, "kx", "bin", "q"), "");
  fs.writeFileSync(path.join(ws, "kx", "kc.lic"), "");
  const fake = fakeVscode({ "terminal.qBinary": "./kx/bin/q" }, {}, ws);
  await loadTerminals(fake).repl();
  const line = fake.terminals[0].sent[0];
  assert.ok(line.includes(`QHOME=${path.join(ws, "kx", "q")}`) && line.includes(`QLIC=${path.join(ws, "kx")}`), line);
});

test("a virtual workspace folder is not a q terminal's working directory (#1843)", async () => {
  const fake = fakeVscode();
  fake.vscode.workspace.workspaceFolders[0].uri.scheme = "vscode-vfs";
  await loadTerminals(fake).repl();
  assert.strictEqual(fake.terminals[0].options.cwd, undefined);
});

test("another file, and none: a missing .env is no .env and says nothing", async () => {
  const fake = fakeVscode({ "env.file": "config/q.env" }, { "/ws/config/q.env": "QLIC=/lic\n" });
  await loadTerminals(fake).repl();
  assert.deepStrictEqual(fake.terminals[0].options.env, { QLIC: "/lic", QLINT_DOTENV_QLIC: "/lic" });
  const none = fakeVscode();
  await loadTerminals(none).repl();
  assert.strictEqual(none.terminals[0].options.env, undefined);
  assert.deepStrictEqual(none.messages, []);
});

test("off: the .env file is not read and the terminal gets none of it", async () => {
  let reads = 0;
  const fake = fakeVscode({ "env.enable": false }, { "/ws/.env": "TOKEN=x\n" });
  const readFile = fake.vscode.workspace.fs.readFile;
  fake.vscode.workspace.fs.readFile = (uri) => (reads++, readFile(uri));
  await loadTerminals(fake).repl();
  assert.strictEqual(reads, 0);
  assert.strictEqual(fake.terminals[0].options.env, undefined);
});

test("a launched process gets the .env file's variables under its definition's own", async (t) => {
  // Loaded last: the stand-in module from vscode_stub stays for this test.
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]out[\\/]/.test(key)) delete require.cache[key];
  }
  const { stub, vscode } = require("./vscode_stub.js");
  const { Live } = require("../out/live.js");
  const { Launcher } = require("../out/launcherview.js");
  const net = require("node:net");
  stub.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dotenv-"));
  fs.writeFileSync(path.join(dir, ".env"), "FROM_ENV=env\nBOTH=env\n");
  fs.writeFileSync(
    path.join(dir, "fake.js"),
    `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({ FROM_ENV: process.env.FROM_ENV, BOTH: process.env.BOTH }));
const port = Number(process.argv[process.argv.indexOf("-p") + 1].split(":").pop());
require("net").createServer((s) => s.end()).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));`,
  );
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: "w" }];
  vscode.workspace.getWorkspaceFolder = () => vscode.workspace.workspaceFolders[0];
  vscode.workspace.fs = { readFile: async (uri) => fs.readFileSync(uri.fsPath) };
  vscode.window.createOutputChannel = () => ({ append() {}, appendLine() {}, show() {}, clear() {}, dispose() {} });
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [
    { label: "p", host: "127.0.0.1", port, tags: [], launch: { command: process.execPath, script: "fake.js", cwd: dir, env: { BOTH: "own" } } },
  ]);
  const live = new Live(context);
  new Launcher(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.stopProcess")?.("p");
    for (const d of context.subscriptions) d.dispose?.();
    vscode.workspace.workspaceFolders = undefined;
  });
  await stub.commands.get("q-lint.startProcess")("p");
  const seen = path.join(dir, "seen.json");
  for (let i = 0; i < 100 && !fs.existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(seen, "utf8")), { FROM_ENV: "env", BOTH: "own" });
});
