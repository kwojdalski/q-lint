// Direct evaluation per process (#2470): which processes are evaluated
// directly, what a direct connection refuses before it sends, how the
// process list keeps the choice, and what the Process Explorer reads of a
// direct process. Run after `tsc`; no q and no editor needed
// (direct_q.test.js drives a real KDB-X).
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { QConnection, DirectRefused, directRefusal } = require("../out/qclient.js");
const { directMode, evaluationText, flagsText } = require("../out/querycontrols.js");
const { evaluationOf, parseProcesses, processTooltip, resaved, withExtras } = require("../out/processes.js");
const { explorerTree, gatherDirect, directRequests, NAMESPACES_REQUEST } = require("../out/explorer.js");

const p = (extra = {}) => ({ label: "hdb", host: "h", port: 1, tags: [], ...extra });

test("a process's own evaluation wins; one with none follows q-lint.query.unwrapped", () => {
  assert.deepStrictEqual(directMode(p({ evaluation: "direct" }), false), { label: "hdb", from: "process" });
  assert.strictEqual(directMode(p({ evaluation: "wrapped" }), true), undefined);
  assert.deepStrictEqual(directMode(p(), true), { label: "hdb", from: "setting" });
  assert.strictEqual(directMode(p(), false), undefined);
});

test("the evaluation is read from a process list, kept by an edit, and shown in the tooltip", () => {
  assert.strictEqual(evaluationOf(" Direct "), "direct");
  assert.strictEqual(evaluationOf("wrapped"), "wrapped");
  assert.strictEqual(evaluationOf("raw"), undefined);
  assert.strictEqual(evaluationOf(true), undefined);
  const { processes } = parseProcesses([
    { label: "a", host: "h", port: 1, evaluation: "direct" },
    { label: "b", host: "h", port: 2, evaluation: "nope" },
  ]);
  assert.strictEqual(processes[0].evaluation, "direct");
  assert.strictEqual("evaluation" in processes[1], false);
  // From a discovery server's list too: it runs nothing.
  assert.strictEqual(parseProcesses([{ label: "a", host: "h", port: 1, evaluation: "direct" }], false).processes[0].evaluation, "direct");
  // Edit Process asks for none of the extras, and keeps them.
  assert.strictEqual(withExtras({ label: "a", host: "x", port: 3, tags: [] }, processes[0]).evaluation, "direct");
  // The connected process takes a new evaluation at once, and loses one cleared.
  assert.strictEqual(resaved(p(), p({ evaluation: "direct" })).evaluation, "direct");
  assert.strictEqual("evaluation" in resaved(p({ evaluation: "direct" }), p()), false);
  assert.match(processTooltip(p({ evaluation: "direct" })), /evaluation: direct - code is sent as plain strings: no backtrace, no reval/);
  assert.match(processTooltip(p({ evaluation: "wrapped" })), /evaluation: wrapped/);
  assert.doesNotMatch(processTooltip(p()), /evaluation/);
});

test("the status bar says direct for the active process, and its tooltip what that costs", () => {
  assert.strictEqual(flagsText(false, false, true), "$(symbol-string) direct");
  assert.strictEqual(flagsText(false, true, false), "$(symbol-string) unwrapped");
  assert.strictEqual(flagsText(false, false, false), "");
  assert.match(evaluationText("hdb", { label: "hdb", from: "process" }, true), /direct \(its "evaluation": "direct"\).*no backtrace, no reval/);
  assert.match(evaluationText("hdb", { label: "hdb", from: "setting" }, false), /direct \(q-lint\.query\.unwrapped\)/);
  assert.match(evaluationText("rdb", undefined, false), /wrapped - q-lint's lambda/);
});

test("the refusal names the mode and how to change it", () => {
  assert.match(directRefusal({ label: "hdb", from: "process" }), /^this needs q-lint's own evaluator lambda, and hdb uses direct evaluation.*nothing was sent\. Set Process Evaluation on hdb/);
  assert.match(directRefusal({ label: "hdb", from: "setting" }), /q-lint\.query\.unwrapped \(Toggle Unwrapped Query\)/);
});

/// A q process played by a socket server: it answers the handshake and
/// keeps every byte sent after it.
async function recordingQ(t) {
  const got = [];
  const server = net.createServer((socket) => {
    let shook = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      got.push(chunk);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { port: server.address().port, got };
}

test("a direct connection refuses q-lint's lambdas before writing a byte", async (t) => {
  const q = await recordingQ(t);
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  connection.direct = () => ({ label: "hdb", from: "process" });
  assert.strictEqual(connection.isDirect, true);
  await assert.rejects(connection.call("{x}", 1), (e) => e instanceof DirectRefused && /nothing was sent/.test(e.message));
  await assert.rejects(connection.query(["til 3"], [25, 80]), DirectRefused);
  await assert.rejects(connection.queryGrid(["til 3"], [25, 80], 10), DirectRefused);
  connection.readOnly = true;
  await assert.rejects(connection.query(["til 3"], [25, 80]), DirectRefused);
  assert.throws(() => connection.sendAsync("{x}", 1), DirectRefused);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(q.got, []);
  assert.strictEqual(connection.isBusy, false);
  // A plain string still goes.
  void connection.evaluate("til 3").catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(Buffer.concat(q.got).subarray(14).toString(), "til 3");
});

test("a wrapped connection sends as before", async (t) => {
  const q = await recordingQ(t);
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  assert.strictEqual(connection.isDirect, false);
  void connection.call("{x}", 1).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(q.got.length > 0);
});

test("the explorer reads a direct process with one plain request a part, and shows a refused part as unavailable", async () => {
  const sent = [];
  const answers = {
    [NAMESPACES_REQUEST]: ["", "q", "Q", "foo", "priv", "z"],
    "tables[]": ["t"],
    "\\f": ["f"],
    "\\v": ["t", "v"],
    ".Q.pt": [],
    "\\a .foo": ["q"],
    "\\f .foo": ["g"],
    "\\v .foo": ["q", "sub", "w"],
    "\\a .z": [],
    "\\f .z": [],
    "\\v .z": [],
  };
  const read = async (request) => {
    sent.push(request);
    if (request.includes(".priv")) {
      return { ok: false, error: `pm: no read permission on [${request}]` };
    }
    return { ok: true, value: answers[request] };
  };
  const g = await gatherDirect(read, ["q", "Q"]);
  // No lambda, and nothing under an excluded namespace.
  assert.deepStrictEqual(sent, [
    "key`",
    ...directRequests(".").map((r) => r.request),
    ".Q.pt",
    ...directRequests(".foo").map((r) => r.request),
    ...directRequests(".priv").map((r) => r.request),
    ...directRequests(".z").map((r) => r.request),
  ]);
  assert.ok(sent.every((s) => !s.includes("{")));
  const kinds = g.entries.map((e) => `${e.ns} ${e.name} ${e.kind}`);
  assert.deepStrictEqual(kinds, [". f function", ". t table", ". v variable", ".foo g function", ".foo q table", ".foo sub variable", ".foo w variable"]);
  assert.strictEqual(g.unavailable.length, 3);
  const tree = explorerTree(g, ["q", "Q"]);
  const root = tree.find((n) => n.label === ".");
  assert.deepStrictEqual(root.children.map((c) => [c.label, c.description]), [["Tables", "1"], ["Functions", "1"], ["Variables", "1"]]);
  assert.match(root.children[0].children[0].description, /not read: direct evaluation/);
  const priv = tree.find((n) => n.label === ".priv");
  assert.deepStrictEqual(priv.children.map((c) => [c.label, c.description]), [
    ["Tables unavailable", "pm: no read permission on [\\a .priv]"],
    ["Functions unavailable", "pm: no read permission on [\\f .priv]"],
    ["Variables unavailable", "pm: no read permission on [\\v .priv]"],
  ]);
  // A partitioned table is marked so, and Preview reads it by .Q.ind (#2481);
  // .Q.pt refused, each table is read as any is.
  const { previewCode } = require("../out/explorer.js");
  const hdb = await gatherDirect(async (r) => ({ ok: true, value: r === "tables[]" ? ["pt", "sp"] : r === ".Q.pt" ? ["pt"] : [] }), []);
  assert.deepStrictEqual(hdb.entries.map((e) => [e.name, e.partitioned, previewCode({ kind: "table", name: e.name, partitioned: e.partitioned }, 5)]), [
    ["pt", true, ".Q.ind[pt;til 5&count pt]"],
    ["sp", false, "5 sublist sp"],
  ]);
  const refused = await gatherDirect(async (r) => (r === ".Q.pt" ? { ok: false, error: "pm: no" } : { ok: true, value: r === "tables[]" ? ["pt"] : [] }), []);
  assert.deepStrictEqual([refused.entries.map((e) => e.partitioned), refused.unavailable], [[false], undefined]);
  // The namespaces refused: the root is still read.
  const bare = await gatherDirect(async (r) => (r === "key`" ? { ok: false, error: "pm: no" } : { ok: true, value: r === "tables[]" ? ["t"] : [] }), []);
  const top = explorerTree(bare, []);
  assert.deepStrictEqual(top.map((n) => n.label), [".", "Namespaces unavailable"]);
  // Bounded as GATHER is: names a namespace, namespaces a read.
  const many = await gatherDirect(async (r) => ({ ok: true, value: r === "key`" ? ["a", "b", "c"] : r.startsWith("\\v") ? ["x", "y", "z"] : [] }), [], [2, 2]);
  assert.deepStrictEqual([many.spaces.map((s) => s.ns), many.more, many.entries.filter((e) => e.ns === ".").map((e) => e.name)], [[".", ".a"], 2, ["x", "y"]]);
});
