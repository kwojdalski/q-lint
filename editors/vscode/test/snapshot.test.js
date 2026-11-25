// Snapshot tests (#981): the file format, and Record Query Snapshot and
// Update Snapshot with the vscode stub - each shows what it writes, asks
// first, never overwrites unasked, and refuses while turned off.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { formatSnapshot, parseSnapshot, sameResult, snapshotQuery, snapshotName, validName, preview, SNAPSHOT_COMMANDS, SNAPSHOT_RUN } = require("../out/snapshot.js");
const { registerSnapshots } = require("../out/snapshotview.js");

test("a snapshot file round-trips, and results compare without trailing blanks", () => {
  const text = formatSnapshot({ query: "select from t\n  where a>1", result: "a \n-\n2\n\n" });
  assert.strictEqual(text, "// q-lint snapshot\n// query\nselect from t\n  where a>1\n// result\na\n-\n2\n");
  assert.deepStrictEqual(parseSnapshot(text), { query: "select from t\n  where a>1", result: "a\n-\n2" });
  assert.deepStrictEqual(parseSnapshot(text.replaceAll("\n", "\r\n")), { query: "select from t\n  where a>1", result: "a\n-\n2" });
  // A CRLF document's selection is written with \n line ends, and read back as it is (#1415).
  const crlf = formatSnapshot({ query: "select from t\r\n  where a>1", result: "a" });
  assert.ok(!crlf.includes("\r"));
  assert.strictEqual(parseSnapshot(crlf).query, snapshotQuery("select from t\r\n  where a>1"));
  assert.strictEqual(parseSnapshot("x"), undefined);
  assert.strictEqual(parseSnapshot("// q-lint snapshot\n// query\n// result\n1"), undefined);
  assert.strictEqual(sameResult("a  \nb\n", "a\nb"), true);
  assert.strictEqual(sameResult("a\nb", "a\nc"), false);
  assert.strictEqual(snapshotName("select max p by s from trade"), "select_max_p_by_s_from_trade");
  assert.strictEqual(snapshotName("{}"), "snapshot");
  assert.strictEqual(validName("trades_1"), true);
  assert.strictEqual(validName("../x"), false);
  assert.strictEqual(validName(".hidden"), false);
  assert.strictEqual(preview("1\n2\n3", 2), "1\n2\n... 1 more lines");
});

test("a query holding the line '// result' is read back whole, not cut at it (#1885)", () => {
  for (const query of ["r:select from t\n// result\nr", "// result\n1+1", "a\n//\\ result\n//\\\\ result\nb", "a\n// result"]) {
    const text = formatSnapshot({ query, result: "a\n-\n1" });
    assert.deepStrictEqual(parseSnapshot(text), { query, result: "a\n-\n1" }, query);
    // The file holds the marker once: where the result starts.
    assert.strictEqual(text.split("\n").filter((l) => l === "// result").length, 1, query);
  }
  // The line is marked in the file, and only that line.
  assert.strictEqual(formatSnapshot({ query: "a\n// result\n// results\nb", result: "1" }), "// q-lint snapshot\n// query\na\n//\\ result\n// results\nb\n// result\n1\n");
  // A file written before, whose query has no such line, reads as it did.
  assert.deepStrictEqual(parseSnapshot("// q-lint snapshot\n// query\nselect from t\n// results\n// result\na\n"), { query: "select from t\n// results", result: "a" });
  // A result that prints the line is the result still.
  assert.deepStrictEqual(parseSnapshot(formatSnapshot({ query: "x", result: "a\n// result\nb" })), { query: "x", result: "a\n// result\nb" });
});

function setup(files, answer) {
  stub.reset();
  const written = [];
  vscode.workspace.fs = {
    readFile: async (uri) => {
      if (!(uri.fsPath in files)) throw new Error("ENOENT");
      return Buffer.from(files[uri.fsPath], "utf8");
    },
    writeFile: async (uri, data) => {
      files[uri.fsPath] = Buffer.from(data).toString("utf8");
      written.push(uri.fsPath);
    },
    createDirectory: async () => {},
  };
  vscode.workspace.asRelativePath = (uri) => uri.fsPath;
  vscode.window.activeTextEditor = { document: { uri: Object.assign(vscode.Uri.file("/ws/src/a.q"), { scheme: "file" }) } };
  const sent = [];
  const live = {
    code: "select from t",
    async codeFromEditor() {
      return this.code;
    },
    async runOnActive(code, query) {
      sent.push(code);
      return { process: "dev", value: await query({ call: async (lambda, statements, size) => (assert.strictEqual(lambda, SNAPSHOT_RUN), answer(statements, size)) }) };
    },
  };
  let told = 0;
  registerSnapshots(stub.newContext(), live, () => told++);
  return { written, sent, live, told: () => told };
}

test("Record Query Snapshot shows what it writes and asks; a replacement asks too; Escape writes nothing", async () => {
  const files = {};
  let rows = ["a", "-", "1"];
  const s = setup(files, () => ({ ok: true, type: 98, text: rows }));
  const record = stub.commands.get(SNAPSHOT_COMMANDS.record);
  // Escape at the confirmation: nothing written.
  stub.inputs.push("trades");
  stub.picks.push(undefined);
  await record();
  assert.deepStrictEqual(s.written, []);
  assert.match(stub.messages.at(-1)[1], /Write a snapshot to \/ws\/src\/__snapshots__\/trades\.qsnap\?/);
  stub.inputs.push("trades");
  stub.picks.push("Write");
  await record();
  assert.deepStrictEqual(s.written, ["/ws/src/__snapshots__/trades.qsnap"]);
  assert.deepStrictEqual(parseSnapshot(files["/ws/src/__snapshots__/trades.qsnap"]), { query: "select from t", result: "a\n-\n1" });
  assert.strictEqual(s.told(), 1);
  // The same result again: nothing to write, nothing asked.
  stub.inputs.push("trades");
  await record();
  assert.strictEqual(s.written.length, 1);
  assert.match(stub.messages.at(-1)[1], /already holds this result/);
  // A new result over an existing file asks to replace it.
  rows = ["a", "-", "2"];
  stub.inputs.push("trades");
  stub.picks.push(undefined);
  await record();
  assert.match(stub.messages.at(-1)[1], /Replace the snapshot/);
  assert.strictEqual(s.written.length, 1);
  assert.strictEqual(parseSnapshot(files["/ws/src/__snapshots__/trades.qsnap"]).result, "a\n-\n1");
});

test("a failed query writes nothing; Update Snapshot rewrites only on Replace; off, both refuse and send nothing", async () => {
  const files = { "/ws/src/__snapshots__/t.qsnap": formatSnapshot({ query: "count t", result: "3" }) };
  let answer = { ok: false, error: "t", trace: "" };
  const s = setup(files, () => answer);
  stub.inputs.push("x");
  await stub.commands.get(SNAPSHOT_COMMANDS.record)();
  assert.match(stub.messages.at(-1)[1], /query failed on dev \('t\); no snapshot was written/);
  assert.deepStrictEqual(s.written, []);
  answer = { ok: true, type: -7, text: ["4"] };
  const update = stub.commands.get(SNAPSHOT_COMMANDS.update);
  const item = { uri: vscode.Uri.file("/ws/src/__snapshots__/t.qsnap") };
  stub.picks.push(undefined);
  await update(item);
  assert.deepStrictEqual(s.written, []);
  stub.picks.push("Replace");
  await update(item);
  assert.deepStrictEqual(parseSnapshot(files["/ws/src/__snapshots__/t.qsnap"]), { query: "count t", result: "4" });
  assert.deepStrictEqual(s.sent, ["select from t", "count t", "count t"]);

  stub.config.user["snapshotTests.enable"] = false;
  await stub.commands.get(SNAPSHOT_COMMANDS.record)();
  await update(item);
  assert.strictEqual(s.sent.length, 3);
  assert.match(stub.messages.at(-1)[1], /q-lint\.snapshotTests\.enable to true/);
});

test("a declined guard or a dropped connection writes nothing and says why, without rejecting (#2261)", async () => {
  const files = { "/ws/src/__snapshots__/t.qsnap": formatSnapshot({ query: "count t", result: "3" }) };
  const s = setup(files, () => ({ ok: true, type: -7, text: ["4"] }));
  const item = { uri: vscode.Uri.file("/ws/src/__snapshots__/t.qsnap") };
  for (const why of ["Not run: changing the read-only process prodq was not confirmed.", "the connection closed before the process answered"]) {
    s.live.runOnActive = async () => {
      throw new Error(why);
    };
    stub.inputs.push("snap1");
    await stub.commands.get(SNAPSHOT_COMMANDS.record)();
    assert.deepStrictEqual(stub.messages.at(-1), ["info", `q-lint: no snapshot was written: ${why}`]);
    await stub.commands.get(SNAPSHOT_COMMANDS.update)(item);
    assert.deepStrictEqual(stub.messages.at(-1), ["info", `q-lint: no snapshot was written: ${why}`]);
  }
  assert.deepStrictEqual(s.written, []);
  assert.strictEqual(s.told(), 0);
});
