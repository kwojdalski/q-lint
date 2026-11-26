// Locals at the error (#985): the functions a backtrace names, the document
// shown, and Capture Locals at Last Error with the vscode stub - asked first,
// sent through the guard, the function put back in the same call; off, it
// refuses and sends nothing. The q side is instrument_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { namedFrames, readCapture, localsDocument, CAPTURE_LOCALS } = require("../out/locals.js");
const { localsText, installLambda, restoreExpression } = require("../out/instrument.js");
const { DRIFT } = require("../out/definitions.js");
const { RUN } = require("../out/query.js");

const TRACE = "  [5]  /w/lib.q:5: .ns.m:\n  c:a+b;\n  d+`x}\n   ^\n  [4]  /w/lib.q:9: run:{.ns.m[1;2]}\n            ^\n  [3]  (.Q.trp)\n";

// The failed query's own statement frames name what it assigned: `res` of
// `res:f 1`, and a caller's `r` of `r:.Q.trp[...]`, are no functions (#2412).
test("a frame assigning no lambda is not offered as a function (#2412)", () => {
  assert.deepStrictEqual(namedFrames("  [2]  f:{[x] x+`a}\n             ^\n  [1]  res:f 1\n           ^\n  [0]  res:f 1\n           ^\n"), [{ name: "f", where: "" }]);
  const trace = "  [5]  /w/lib.q:4: .ns.f:\n  b:a+1;\n  c:b+`x;\n     ^\n  c}\n  [4]  /w/bt.q:2: {.ns.f 1}\n                   ^\n  [3]  (.Q.trp)\n\n  [2]  /w/bt.q:2: r:.Q.trp[{.ns.f 1};::;{.Q.sbt y}];\n                    ^\n";
  assert.deepStrictEqual(namedFrames(trace), [{ name: ".ns.f", where: "/w/lib.q:4" }]);
});

test("a backtrace's named functions, and what is shown of a capture", () => {
  assert.deepStrictEqual(namedFrames(TRACE), [
    { name: ".ns.m", where: "/w/lib.q:5" },
    { name: "run", where: "/w/lib.q:9" },
  ]);
  const text = "{[a;b]\n  c:a+b;\n  d:c*2;\n  d+`x}";
  const captured = localsText(text);
  const capture = readCapture({ args: { a: "1", b: ["2"] }, locals: { c: "3", d: "6" }, at: 2 });
  assert.deepStrictEqual(capture, { args: { a: "1", b: "2" }, locals: { c: "3", d: "6" }, at: 2 });
  assert.strictEqual(
    localsDocument({ name: ".ns.m", process: "dev", code: "run[]", text, statements: captured.statements, capture, error: "type" }),
    [
      "/ .ns.m on dev, captured by running the failed query again:",
      "/   run[]",
      "/ it signalled 'type; .ns.m was at statement 3 of 3: d+`x",
      "",
      "/ arguments",
      "a: 1",
      "b: 2",
      "",
      "/ locals, as a statement at the top of the body last assigned each",
      "c: 3",
      "d: 6",
      "",
    ].join("\n"),
  );
  assert.match(
    localsDocument({ name: "f", process: "dev", code: "g 1", text, statements: captured.statements, capture: readCapture({ args: {}, locals: {}, at: null }), error: "x" }),
    /f was not called before it signalled 'x\./,
  );
});

/// `run` is what the query run again does in place of answering 'type.
function setup(failure, run) {
  stub.reset();
  const sent = [];
  const apart = [];
  const process = { label: "dev", tags: [] };
  const text = "{[a;b]\n  c:a+b;\n  d+`x}";
  const live = {
    lastFailure: failure,
    guarded: [],
    activeLabel: () => "dev",
    activeProcess: () => process,
    guardAllows: async () => true,
    // A connection of its own, as #1892's restore opens.
    openSeparate: async (to) => ({ call: async (lambda) => (apart.push([to.label, lambda]), { kept: [], d: null }), abort() {} }),
    async runOnActive(code, query) {
      this.guarded.push(code);
      const connection = {
        call: async (lambda, ...args) => {
          if (this.dropped) throw new Error("connection closed");
          sent.push(lambda);
          if (lambda === RUN && run !== undefined) return run(this);
          if (lambda === restoreExpression("err")) return sent.filter((l) => l === lambda).length === 1 ? { kept: [], d: null } : { kept: [], d: { args: { a: "1", b: "2" }, locals: { c: "3" }, at: 1 } };
          if (lambda === DRIFT) return { name: [args[0]], state: ["lambda"], text: [text] };
          if (lambda === installLambda("err")) return ["ok"];
          if (lambda === RUN) return { ok: false, error: "type", trace: "" };
          throw new Error("unexpected");
        },
      };
      return { process: process.label, value: await query(connection) };
    },
  };
  let shownText;
  vscode.workspace.registerTextDocumentContentProvider = (_scheme, provider) => ((shownText = provider), { dispose() {} });
  vscode.workspace.openTextDocument = async (uri) => uri;
  vscode.window.showTextDocument = async () => undefined;
  vscode.Uri.from = ({ path }) => vscode.Uri.file(path);
  const { registerLocalsAtError } = require("../out/localsview.js");
  const api = registerLocalsAtError(stub.newContext(), live);
  return { sent, apart, live, api, shown: () => shownText };
}

test("Capture Locals at Last Error asks, instruments, runs again and puts the function back", async () => {
  const s = setup({ process: "dev", code: ".ns.m[1;2]", error: "type", trace: TRACE });
  stub.picks.push({ label: ".ns.m", frame: { name: ".ns.m", where: "/w/lib.q:5" } });
  // Declined at the confirmation: nothing sent.
  stub.picks.push(undefined);
  await stub.commands.get(CAPTURE_LOCALS)();
  assert.deepStrictEqual(s.sent, []);
  assert.match(stub.messages.at(-1)[1], /Run the failed query again on dev, with \.ns\.m keeping its arguments and locals\?/);
  stub.picks.push({ label: ".ns.m", frame: { name: ".ns.m", where: "/w/lib.q:5" } });
  stub.picks.push("Run Again");
  await stub.commands.get(CAPTURE_LOCALS)();
  assert.deepStrictEqual(s.sent, [restoreExpression("err"), DRIFT, installLambda("err"), RUN, restoreExpression("err")]);
  assert.ok(s.live.guarded[0].endsWith("\n.ns.m[1;2]"), "the guard reads the replacing and the query");
  assert.match(s.api.last(), /signalled 'type; \.ns\.m was at statement 2 of 2: d\+`x/);
  assert.match(s.api.last(), /\nc: 3\n/);
});

test("a run again that drops the connection puts the function back on the process it was replaced on, or says it is left (#1903)", async () => {
  const again = () => {
    stub.picks.push({ label: ".ns.m", frame: { name: ".ns.m", where: "/w/lib.q:5" } });
    stub.picks.push("Run Again");
    return stub.commands.get(CAPTURE_LOCALS)();
  };
  // The process's timeout: the connection is dropped, and another process
  // is the active one by the time the run is given up.
  const timeOut = (live) => {
    live.dropped = true;
    live.activeProcess = () => ({ label: "other", tags: [] });
    throw new Error("Query timed out after 1 s");
  };
  const s = setup({ process: "dev", code: ".ns.m[1;2]", error: "type", trace: TRACE }, timeOut);
  await again();
  assert.deepStrictEqual(s.sent, [restoreExpression("err"), DRIFT, installLambda("err"), RUN]);
  assert.deepStrictEqual(s.apart, [["dev", restoreExpression("err")]]);
  assert.deepStrictEqual(stub.messages.at(-1), ["error", "q-lint: no locals captured: Query timed out after 1 s. .ns.m was put back on dev."]);
  // Not reachable either: said by name, with the process.
  const left = setup({ process: "dev", code: ".ns.m[1;2]", error: "type", trace: TRACE }, timeOut);
  left.live.openSeparate = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:5010");
  };
  await again();
  const told = stub.messages.map(([, text]) => text).join("\n");
  assert.match(told, /no locals captured: Query timed out after 1 s/);
  assert.match(
    told,
    /q-lint: \.ns\.m may still be instrumented on dev: it could not be put back \(Query timed out after 1 s; nor over a connection of its own: connect ECONNREFUSED 127\.0\.0\.1:5010\)\. The next locals capture on dev puts it back first\./,
  );
  // An answer that cannot be read, on a connection that still holds: put back there.
  const odd = setup({ process: "dev", code: ".ns.m[1;2]", error: "type", trace: TRACE }, () => 42);
  await again();
  assert.deepStrictEqual(odd.sent, [restoreExpression("err"), DRIFT, installLambda("err"), RUN, restoreExpression("err")]);
  assert.deepStrictEqual(odd.apart, []);
  assert.match(stub.messages.at(-1)[1], /no locals captured: the process answered something other than a query result/);
  assert.doesNotMatch(stub.messages.map(([, text]) => text).join("\n"), /may still be instrumented/);
});

test("the guard reads the replacing when the failed query ends the script or opens a comment (#1422)", async () => {
  const { writes } = require("../out/guard.js");
  for (const code of ["f[1]\n\\\nnotes", "f[1]\n/\nnotes"]) {
    const s = setup({ process: "dev", code, error: "type", trace: TRACE });
    stub.picks.push({ label: ".ns.m", frame: { name: ".ns.m", where: "/w/lib.q:5" } });
    stub.picks.push("Run Again");
    await stub.commands.get(CAPTURE_LOCALS)();
    assert.ok(writes(s.live.guarded[0]).length > 0, JSON.stringify(s.live.guarded[0]));
  }
});

test("with no failure, or turned off, nothing is sent", async () => {
  const s = setup(undefined);
  await stub.commands.get(CAPTURE_LOCALS)();
  assert.match(stub.messages.at(-1)[1], /no query has failed yet/);
  s.live.lastFailure = { process: "dev", code: "f 1", error: "type", trace: TRACE };
  stub.config.user["localsAtError.enable"] = false;
  await stub.commands.get(CAPTURE_LOCALS)();
  assert.match(stub.messages.at(-1)[1], /q-lint\.localsAtError\.enable to true/);
  assert.deepStrictEqual(s.sent, []);
});

test("Run Again sends nothing when another process became active while it was asked (#1292)", async (t) => {
  const { setUp } = require("./fakeq.js");
  const { registerLocalsAtError } = require("../out/localsview.js");
  vscode.workspace.registerTextDocumentContentProvider = () => ({ dispose() {} });
  const { q, live } = await setUp(t, { register: registerLocalsAtError, more: [{ label: "other" }] });
  await live.connectTo("rdb");
  live.lastFailure = { process: "rdb", code: ".ns.m[1;2]", error: "type", trace: TRACE };
  stub.picks.push({ label: ".ns.m", frame: { name: ".ns.m", where: "/w/lib.q:5" } });
  stub.picks.push(async () => (await live.connectTo("other"), "Run Again"));
  const before = q.sent.length;
  await stub.commands.get(CAPTURE_LOCALS)();
  assert.strictEqual(q.sent.length, before);
  assert.match(stub.messages.at(-1)[1], /no locals captured: rdb is no longer the active process; nothing was run/);
});
