// Capture Locals at Last Error against a real q (#985): the command, with
// the vscode stub answering its questions, looks into a query that failed
// inside a function loaded from a file, shows its arguments and locals at
// the error, and leaves the function as it was. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { connect, skip } = require("./qserver.js");
const { RUN, readAnswer } = require("../out/query.js");
const { CAPTURE_LOCALS } = require("../out/locals.js");

const LIB = "\\d .ns\nm:{[a;b]\n  c:a+b;\n  d:c*2;\n  d+`x}\n\\d .\nrun:{[n] .ns.m[n;n+1]}\n";

test("the locals of the innermost function are shown, and it is put back", { skip }, async (t) => {
  const { connection: c } = await connect(t, "\\l lib.q\n", { "lib.q": LIB });
  const before = (await c.evaluate("{.Q.s1 (value x;`qlint in key`.)}`.ns.m")).value;
  const failed = readAnswer(await c.call(RUN, ["run 1"], [25, 200]));
  assert.strictEqual(failed.ok, false);
  stub.reset();
  vscode.workspace.registerTextDocumentContentProvider = () => ({ dispose() {} });
  vscode.workspace.openTextDocument = async (uri) => uri;
  vscode.window.showTextDocument = async () => undefined;
  vscode.Uri.from = ({ path }) => vscode.Uri.file(path);
  const live = {
    lastFailure: { process: "dev", code: "run 1", error: failed.error, trace: failed.trace },
    activeLabel: () => "dev",
    async runOnActive(_code, query) {
      return { process: "dev", value: await query(c) };
    },
  };
  const { registerLocalsAtError } = require("../out/localsview.js");
  const api = registerLocalsAtError(stub.newContext(), live);
  // The innermost of the two functions the backtrace names, then confirmed.
  stub.picks.push((options) => options.items[0]);
  stub.picks.push("Run Again");
  await stub.commands.get(CAPTURE_LOCALS)();
  const shown = api.last();
  assert.ok(shown, JSON.stringify(stub.messages));
  assert.match(shown, /^\/ \.ns\.m on dev/);
  assert.match(shown, /it signalled 'type; \.ns\.m was at statement 3 of 3: d\+`x/);
  assert.match(shown, /\na: 1\nb: 2\n/);
  assert.match(shown, /\nc: 3\nd: 6\n/);
  assert.strictEqual((await c.evaluate("{.Q.s1 (value x;`qlint in key`.)}`.ns.m")).value, before);
});
