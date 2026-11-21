// The backtrace links (#983) with the vscode stub: registered only while
// q-lint.backtraceLinks.enable is on, a frame's file:line linked to the line
// that failed in a real file, a remote path to the workspace's copy, a
// frame with only a name to its definition.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stub, vscode } = require("./vscode_stub");

vscode.Range = class {
  constructor(a, b, c, d) {
    Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d } });
  }
};
vscode.DocumentLink = class {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
};
vscode.Uri.prototype.with = function (change) {
  return Object.assign(Object.create(Object.getPrototypeOf(this)), this, change);
};
const { registerBacktraceLinks, BacktraceLinks } = require("../out/backtraceview.js");

const LIB = ["/ lib", "", "mid:{[a]", "  b:a+1;", "  c:b+`x;", "  d:c*2;", "  d}", ""].join("\n");

function documentOf(text) {
  const lines = text.split("\n");
  return { getText: () => text, lineAt: (i) => ({ text: lines[i] }) };
}

test("registered only while on; turned off, the providers are disposed", () => {
  stub.reset();
  const registered = [];
  vscode.languages.registerDocumentLinkProvider = (selector, provider) => {
    const d = { selector, provider, disposed: false, dispose() { this.disposed = true; } };
    registered.push(d);
    return d;
  };
  vscode.window.registerTerminalLinkProvider = (provider) => {
    const d = { provider, disposed: false, dispose() { this.disposed = true; } };
    registered.push(d);
    return d;
  };
  stub.config.user["backtraceLinks.enable"] = false;
  const links = registerBacktraceLinks(stub.newContext());
  assert.strictEqual(links.registered(), false);
  assert.strictEqual(registered.length, 0);
  stub.config.user["backtraceLinks.enable"] = true;
  stub.changeConfig("q-lint.backtraceLinks.enable");
  assert.strictEqual(registered.length, 2);
  assert.deepStrictEqual(registered[0].selector, [{ scheme: "output" }, { language: "q-console" }]);
  // The terminal link: the header's file:line.
  const [terminal] = registered[1].provider.provideTerminalLinks({ line: "  [1]  /w/lib.q:8: one:{x+`y}" });
  assert.deepStrictEqual([terminal.startIndex, terminal.length, terminal.file, terminal.at], [7, 10, "/w/lib.q", 8]);
  assert.deepStrictEqual(registered[1].provider.provideTerminalLinks({ line: "q)1+1" }), []);
  stub.config.user["backtraceLinks.enable"] = false;
  stub.changeConfig("q-lint.backtraceLinks.enable");
  assert.ok(registered.every((d) => d.disposed));
  assert.strictEqual(links.registered(), false);
});

test("a frame links to the line that failed, in the file or the workspace's copy of it", async () => {
  stub.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-bt-"));
  const file = path.join(dir, "lib.q");
  fs.writeFileSync(file, LIB);
  vscode.workspace.findFiles = async (glob) => (glob === "**/lib.q" ? [vscode.Uri.file(file)] : []);
  const provider = new BacktraceLinks();
  // PeachQ's frame, from this machine.
  const peachq = `'type\n  [4]  ${file}:3: mid:{[a]\n  b:a+1;\n  c:b+\`x;\n     ^\n  d:c*2;\n  d}\n  [3]  mid 1\n       ^\n`;
  const [link] = provider.provideDocumentLinks(documentOf(peachq));
  assert.deepStrictEqual(link.range.start, { line: 1, character: 7 });
  assert.deepStrictEqual(link.range.end, { line: 1, character: 7 + file.length + 2 });
  await provider.resolveDocumentLink(link);
  assert.strictEqual(link.target.fsPath, file);
  assert.strictEqual(link.target.fragment, "L5,6");
  // KDB-X's, printed by a process elsewhere: the workspace's lib.q.
  const kdbx = "  [5]  /srv/app/lib.q:5: mid:\n  b:a+1;\n  c:b+`x;\n     ^\n  d:c*2;\n";
  const [remote] = provider.provideDocumentLinks(documentOf(kdbx));
  await provider.resolveDocumentLink(remote);
  assert.strictEqual(remote.target.fsPath, file);
  assert.strictEqual(remote.target.fragment, "L5,6");
  // Not in the workspace: no target.
  const [nowhere] = provider.provideDocumentLinks(documentOf("  [2]  /srv/other.q:1: f:{x}\n"));
  await provider.resolveDocumentLink(nowhere);
  assert.strictEqual(nowhere.target, undefined);
});

test("a frame with only a name links to its definition in the workspace", async () => {
  stub.reset();
  const asked = [];
  stub.commands.set("vscode.executeWorkspaceSymbolProvider", async (q) => {
    asked.push(q);
    return [
      { name: "m2", containerName: "", location: { uri: vscode.Uri.file("/ws/b.q"), range: { start: { line: 0, character: 0 } } } },
      { name: ".ns.m", containerName: "", location: { uri: vscode.Uri.file("/ws/a.q"), range: { start: { line: 4, character: 0 } } } },
    ];
  });
  const provider = new BacktraceLinks();
  const [link] = provider.provideDocumentLinks(documentOf("  [4]  .ns.m:{x+`a}\n             ^\n"));
  assert.deepStrictEqual([link.range.start.character, link.range.end.character], [7, 12]);
  await provider.resolveDocumentLink(link);
  assert.deepStrictEqual(asked, [".ns.m"]);
  assert.strictEqual(link.target.fsPath, "/ws/a.q");
  assert.strictEqual(link.target.fragment, "L5,1");
});
