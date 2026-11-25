// Running code interactively against a real q process: cells into the
// Interactive Window (#956, #958), the q REPL pane's multiline input and its
// completion from the process's names (#959), and `.qlint.view` and
// `.qlint.plot` defined on the process and called from a query (#960).
// Driven through the stand-in `vscode` module; needs a q binary, so it runs
// only when QLINT_TEST_Q names one, as live_q.test.js does.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Live } = require("../out/live.js");
const { registerInteractive } = require("../out/interactiveview.js");
const { registerRepl } = require("../out/replview.js");
const { registerViewHelpers } = require("../out/viewhelpers.js");
const { INTERACTIVE_COMMANDS: C } = require("../out/interactiveconfig.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// A q process loading `body`, listening on a free port.
async function startQ(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-interactiveq-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, body);
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      return { port, stop: () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    }
    await sleep(100);
  }
  process.kill(-child.pid, "SIGKILL");
  throw new Error("q did not start listening");
}

async function setUp(t, port) {
  stub.reset();
  vscode.languages = { registerCodeLensProvider: () => ({ dispose() {} }) };
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "q", host: "127.0.0.1", port, tags: [] }]);
  const live = new Live(context);
  const repl = registerRepl(context, live);
  const interactive = registerInteractive(context, live, repl);
  const view = registerViewHelpers(context, live);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    vscode.workspace.textDocuments = [];
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  const editor = (text, line = 0) => {
    const document = { uri: vscode.Uri.file("/w/a.q"), languageId: "q", getText: () => text, lineAt: (l) => ({ text: text.split("\n")[l] ?? "" }) };
    vscode.window.activeTextEditor = { document, selection: { active: { line }, isEmpty: true }, revealRange() {} };
    vscode.workspace.textDocuments = [document];
  };
  assert.strictEqual(await live.connectTo("q"), true);
  return { live, interactive, repl, view, editor };
}

test("cells run on q in order into the Interactive Window, a marker inside a statement taken as q takes it", { skip }, async (t) => {
  const q = await startQ("");
  t.after(() => q.stop());
  const { interactive, editor } = await setUp(t, q.port);
  // The middle marker sits between f's first line and its continuation: q
  // reads all three lines as f, and so does the cell.
  editor("/ %% define\nf:{x+\n/ %% not a cell\n  y}\n/ %% use\nf[1;2]\n/\n/ %% commented out\n\\\n/ %% fails\n1+`a\n/ %% never\n2+2");
  await stub.commands.get(C.runAllCells)();
  const shown = interactive.entries().map(({ title, ok, lines }) => ({ title, ok, lines }));
  // `::` prints as "::" on kdb+ and as nothing on PeachQ.
  assert.deepStrictEqual({ ...shown[0], lines: undefined }, { title: "define", ok: true, lines: undefined });
  assert.deepStrictEqual(shown[1], { title: "use", ok: true, lines: ["3"] });
  assert.strictEqual(shown[2].title, "fails");
  assert.strictEqual(shown[2].ok, false);
  assert.strictEqual(shown[2].lines[0], "'type");
  assert.strictEqual(shown.length, 3, "the run stops at the failing cell");
});

test("the REPL runs what is typed across lines inside a bracket, and completes the process's names", { skip }, async (t) => {
  const q = await startQ("");
  t.after(() => q.stop());
  const { repl } = await setUp(t, q.port);
  assert.strictEqual(await repl.enter("myfun:{[a;b]"), "newline");
  assert.strictEqual(await repl.enter("myfun:{[a;b]\na*b}\nmyfun[6;7]"), "ran");
  assert.deepStrictEqual(repl.entries()[0].lines, ["42"]);
  const got = await repl.complete("x:myf", 5);
  assert.deepStrictEqual(got.items, [{ label: "myfun", detail: "q" }]);
});

test("cells and REPL entries run in the \\d the text before them left, as \\l and a console do (#2286)", { skip }, async (t) => {
  const q = await startQ("");
  t.after(() => q.stop());
  const { interactive, repl, editor } = await setUp(t, q.port);
  editor("/ %% setup\n\\d .cdlib\n/ %% define\nadd:{x+y}\n/ %% use\nr:add[1;2]");
  await stub.commands.get(C.runAllCells)();
  assert.deepStrictEqual(interactive.entries().map((e) => e.ok), [true, true, true]);
  // Run Cell alone runs in it too.
  editor("/ %% setup\n\\d .cdlib\n/ %% again\nr2:add[3;4]", 2);
  await stub.commands.get(C.runCell)(undefined, 2);
  assert.strictEqual(await repl.enter("(.cdlib.r;.cdlib.r2;@[value;`add;`undefined])"), "ran");
  assert.deepStrictEqual(repl.entries().at(-1).lines, ["3", "7", "`undefined"]);
  assert.strictEqual(await repl.enter("\\d .zz8"), "ran");
  assert.strictEqual(await repl.enter("dd:4"), "ran");
  assert.strictEqual(await repl.enter("\\d ."), "ran");
  assert.strictEqual(await repl.enter("(.zz8.dd;@[value;`dd;`undefined])"), "ran");
  assert.deepStrictEqual(repl.entries().at(-1).lines, ["4", "`undefined"]);
});

test("code Smart Send gives the REPL runs as the editor has it, a block comment in a lambda no code (#2284)", { skip }, async (t) => {
  const q = await startQ("");
  t.after(() => q.stop());
  const { repl } = await setUp(t, q.port);
  await repl.runFromEditor("rp:{[x]\n  a:x+1;\n/\n  a:a*100;\n\\\n  a}", vscode.Uri.file("/w/a.q"));
  assert.strictEqual(repl.entries().at(-1).ok, true);
  assert.strictEqual(await repl.enter("rp 1"), "ran");
  assert.deepStrictEqual(repl.entries().at(-1).lines, ["2"]);
});

test(".qlint.view and .qlint.plot, defined on the process, open what a query passes them", { skip }, async (t) => {
  const q = await startQ("");
  t.after(() => q.stop());
  const { live, view } = await setUp(t, q.port);
  assert.strictEqual(await stub.commands.get(C.defineView)(), true);
  await live.run("n:count .qlint.view ([] a:1 2 3; b:`x`y`z)");
  await live.run(".qlint.plot `a`b`c!1 4 9f");
  for (let i = 0; i < 50 && view.shown().length < 2; i++) await sleep(20);
  assert.deepStrictEqual(view.shown(), [
    { kind: "view", process: "q", rows: 3 },
    { kind: "plot", process: "q", rows: 3 },
  ]);
  // The value is given back, and nothing is left held.
  stub.messages = [];
  await live.run("if[not (n=3)&()~.qlint.shown;'wrong]");
  assert.strictEqual(live.history()[0].outcome, "ok");
  // An atom has no rows: said, not shown.
  await live.run(".qlint.view 42");
  for (let i = 0; i < 50 && stub.messages.length === 0; i++) await sleep(20);
  assert.ok(stub.messages.some(([, text]) => /has no rows to show: 42/.test(text)));
  assert.strictEqual(view.shown().length, 2);
});
