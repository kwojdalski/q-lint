// Line timings (#986): the statements cut with their lines, the process's
// answer read, what is drawn - and, through the stand-in `vscode` and a q
// process played by a socket server, the command's life: off, it refuses and
// sends nothing; on, it sends the lambda and the statements, and the
// read-only guard holds a write on a guarded process. The q side is
// linetimings_q.test.js.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { statementSpans, readTimings, durationText, bytesText, decorationText, summary, LINE_TIMINGS } = require("../out/linetimings.js");
const { registerLineTimings, TIME_LINES, CLEAR_LINE_TIMINGS } = require("../out/linetimingsview.js");
const { Live } = require("../out/live.js");
const pkg = require("../package.json");

test("statements are cut as q loads a script, each with its lines", () => {
  const text = ["#!/usr/bin/env q", "a:1", "f:{[x]", "  x+1}", "/ a comment", "", "/", "b:2", "\\", "c:3", "\\", "d:4"].join("\n");
  assert.deepStrictEqual(statementSpans(text), [
    { text: "a:1", start: 1, end: 1 },
    { text: "f:{[x]\n  x+1}", start: 2, end: 3 },
    { text: "c:3", start: 9, end: 9 },
  ]);
  // Counted from the selection's first line.
  assert.deepStrictEqual(statementSpans("x:1\ny:2", 10), [
    { text: "x:1", start: 10, end: 10 },
    { text: "y:2", start: 11, end: 11 },
  ]);
});

test("the answer is read, one statement's atoms and a failure included", () => {
  const spans = statementSpans("a:1\nb:a+`x\nc:2");
  const read = readTimings([900, [true, false], [5000, null], [32, null], ["", "type"]], spans);
  assert.strictEqual(read.overheadNs, 900);
  assert.strictEqual(read.notRun, 1);
  assert.deepStrictEqual(
    read.timings.map((t) => [t.start, t.ok, t.ns, t.bytes, t.error]),
    [
      [0, true, 5000, 32, undefined],
      [1, false, 0, undefined, "type"],
    ],
  );
  const one = readTimings([800, true, 1500, 64, ""], spans.slice(0, 1));
  assert.deepStrictEqual(one.timings.map((t) => [t.ns, t.bytes]), [[1500, 64]]);
  assert.throws(() => readTimings("junk", spans), /something other than line timings/);
  assert.throws(() => readTimings([1, [true, true, true, true], [1, 1, 1, 1], [1, 1, 1, 1], ["", "", "", ""]], spans), /line timings/);
});

test("times and sizes read as a person writes them", () => {
  assert.strictEqual(durationText(1500), "1.5 µs");
  assert.strictEqual(durationText(520000), "520 µs");
  assert.strictEqual(durationText(2_340_000), "2.34 ms");
  assert.strictEqual(durationText(85_000_000), "85.0 ms");
  assert.strictEqual(durationText(120e9), "120.0 s");
  assert.strictEqual(bytesText(816), "816 B");
  assert.strictEqual(bytesText(8388928), "8.0 MB");
  // Just under a unit's end, rounding moves it on to the next unit (#1437).
  assert.strictEqual(durationText(999_999), "1.00 ms");
  assert.strictEqual(durationText(59_999_999_999), "60.0 s");
  assert.strictEqual(bytesText(1_048_575), "1.0 MB");
  assert.strictEqual(bytesText(1023), "1023 B");
  assert.strictEqual(decorationText({ ok: true, ns: 2_340_000, bytes: 8388928 }), "  ⏱ 2.34 ms · 8.0 MB");
  assert.strictEqual(decorationText({ ok: true, ns: 1000 }), "  ⏱ 1.0 µs");
  assert.strictEqual(decorationText({ ok: false, ns: 0, error: "type" }), "  ✗ type");
  const s = summary(readTimings([900, [true, false], [5000, null], [32, null], ["", "type"]], statementSpans("a:1\nb:a+`x\nc:2")), "dev");
  assert.match(s, /^Timed 2 statements on dev: 5\.0 µs in all, the slowest on line 1/);
  assert.match(s, /adds about 0\.9 µs a statement\. Line 2 failed: type; 1 after it did not run\.$/);
});

test("the switch is declared on, and the commands only where they can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.query.lineTimings.enable"].default, true);
  for (const id of [TIME_LINES, CLEAR_LINE_TIMINGS]) {
    const command = pkg.contributes.commands.find((c) => c.command === id);
    assert.ok(command.title && command.category === "q-lint", id);
    const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === id);
    assert.match(palette.when, /config\.q-lint\.query\.lineTimings\.enable/);
  }
  const context = pkg.contributes.menus["editor/context"].find((m) => m.command === TIME_LINES);
  assert.match(context.when, /config\.q-lint\.query\.lineTimings\.enable/);
});

/// A q process played by a socket server, answering every message with
/// `answer`; the messages are kept, decoded.
async function fakeQ(answer) {
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        sent.push(deserialize(message));
        const out = serialize(answer);
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    sent,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

function fakeEditors() {
  const drawn = [];
  vscode.Range = class {
    constructor(a, b, c, d) {
      Object.assign(this, typeof a === "object" ? { start: a, end: b } : { start: { line: a, character: b }, end: { line: c, character: d } });
    }
  };
  vscode.window.createTextEditorDecorationType = () => ({ disposed: false, dispose() { this.disposed = true; } });
  vscode.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
  vscode.window.onDidChangeVisibleTextEditors = () => ({ dispose() {} });
  const editor = (text, selection = { isEmpty: true, start: { line: 0 }, end: { line: 0, character: 0 } }) => {
    const lines = text.split("\n");
    const e = {
      document: {
        uri: vscode.Uri.file("/w/a.q"),
        lineCount: lines.length,
        getText: () => text,
        lineAt: (i) => ({ text: lines[i], range: { end: { line: i, character: lines[i].length } } }),
      },
      selection,
      setDecorations: (type, list) => drawn.push(list),
    };
    vscode.window.activeTextEditor = e;
    vscode.window.visibleTextEditors = [e];
    return e;
  };
  return { drawn, editor };
}

async function setUp(t, tags, answer, config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const q = await fakeQ(answer);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags }]);
  const live = new Live(context);
  const timings = registerLineTimings(context, live);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  return { q, live, timings };
}

const ANSWER = [900, [true, true], [5000, 1200000], [32, 8388928], ["", ""]];

test("off, the command refuses and sends nothing; on, each statement is timed and drawn", async (t) => {
  const { drawn, editor } = fakeEditors();
  const { q, live, timings } = await setUp(t, [], ANSWER, { "query.lineTimings.enable": false });
  assert.strictEqual(await live.connectTo("rdb"), true);
  const before = q.sent.length;
  editor("x:til 10\ny:sum x");
  assert.strictEqual(timings.registered(), false);
  assert.match(await stub.commands.get(TIME_LINES)(), /Line timings is turned off\. Set q-lint\.query\.lineTimings\.enable to true/);
  await stub.commands.get(CLEAR_LINE_TIMINGS)();
  assert.match(stub.messages.at(-1)[1], /turned off/);
  assert.strictEqual(q.sent.length, before);
  assert.deepStrictEqual(drawn, []);

  // On without a reload.
  stub.config.user["query.lineTimings.enable"] = true;
  stub.changeConfig("q-lint.query.lineTimings.enable");
  assert.strictEqual(timings.registered(), true);
  const result = await stub.commands.get(TIME_LINES)();
  assert.deepStrictEqual(q.sent.at(-1), [LINE_TIMINGS, ["x:til 10", "y:sum x"]]);
  assert.strictEqual(result.timings.length, 2);
  assert.deepStrictEqual(
    drawn.at(-1).map((d) => [d.range.start.line, d.renderOptions.after.contentText]),
    [
      [0, "  ⏱ 5.0 µs · 32 B"],
      [1, "  ⏱ 1.20 ms · 8.0 MB"],
    ],
  );
  assert.match(stub.messages.at(-1)[1], /^q-lint: Timed 2 statements on rdb/);
  // A selection times only its own lines, counted from where it starts.
  const e = editor("a:1\nx:til 10\ny:sum x\nz:3", { isEmpty: false, start: { line: 1 }, end: { line: 3, character: 0 } });
  e.document.getText = (range) => (range ? "x:til 10\ny:sum x" : "a:1\nx:til 10\ny:sum x\nz:3");
  await stub.commands.get(TIME_LINES)();
  assert.deepStrictEqual(q.sent.at(-1), [LINE_TIMINGS, ["x:til 10", "y:sum x"]]);
  assert.deepStrictEqual(drawn.at(-1).map((d) => d.range.start.line), [1, 2]);
  // Clear, and off again: nothing drawn, nothing more sent.
  await stub.commands.get(CLEAR_LINE_TIMINGS)();
  assert.deepStrictEqual(drawn.at(-1), []);
  const sent = q.sent.length;
  stub.config.user["query.lineTimings.enable"] = false;
  stub.changeConfig("q-lint.query.lineTimings.enable");
  assert.strictEqual(timings.registered(), false);
  await stub.commands.get(TIME_LINES)();
  assert.strictEqual(q.sent.length, sent);
});

test("a file edited while its lines are timed is not drawn on, its old lines being gone (#1119)", async (t) => {
  const { drawn, editor } = fakeEditors();
  const { live } = await setUp(t, [], ANSWER);
  await live.connectTo("rdb");
  const e = editor("x:til 10\ny:sum x");
  let version = 1;
  Object.defineProperty(e.document, "version", { get: () => version });
  const run = live.runOnActive.bind(live);
  live.runOnActive = async (...args) => {
    const ran = await run(...args);
    version++; // a line typed above while the answer was awaited
    return ran;
  };
  const result = await stub.commands.get(TIME_LINES)();
  assert.match(result, /changed while/);
  assert.deepStrictEqual(drawn, []);
});

test("a write on a guarded process is held until confirmed; a read is not asked about", async (t) => {
  const { editor } = fakeEditors();
  const { q, live } = await setUp(t, ["prod"], ANSWER);
  await live.connectTo("rdb");
  const before = q.sent.length;
  editor("trade:([] a:1 2)\ncount trade");
  stub.picks.push(undefined);
  assert.match(await stub.commands.get(TIME_LINES)(), /not confirmed/);
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /would change rdb/.test(text)));
  assert.strictEqual(q.sent.length, before);
  stub.picks.push("Run Anyway");
  await stub.commands.get(TIME_LINES)();
  assert.deepStrictEqual(q.sent.at(-1), [LINE_TIMINGS, ["trade:([] a:1 2)", "count trade"]]);
  stub.messages = [];
  editor("count trade\nselect from trade");
  await stub.commands.get(TIME_LINES)();
  assert.ok(!stub.messages.some(([kind]) => kind === "warning"));
  assert.deepStrictEqual(q.sent.at(-1)[1], ["count trade", "select from trade"]);
});
