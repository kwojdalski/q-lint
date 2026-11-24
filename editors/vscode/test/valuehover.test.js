// The live value hover (#940): what the process's answer becomes, and the
// provider's life - registered only while q-lint.liveValueHover.enable is
// on (off by default), asking nothing of the server or the process when it
// is off, and never asking a production process. The q side is
// valuehover_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { readPreview, previewMarkdown, previewNames, PREVIEW_LIMIT } = require("../out/valuehover.js");
const { registerValueHover, GLOBAL_AT } = require("../out/valuehoverview.js");
const pkg = require("../package.json");

test("an answer is read, and shown as the console prints it under a heading", () => {
  const p = readPreview({ found: true, name: ".lib.rate", type: -7, count: 1, text: "2\n" });
  assert.deepStrictEqual(p, { found: true, name: ".lib.rate", type: -7, count: 1, text: "2\n" });
  assert.strictEqual(previewMarkdown(p, "dev"), "**\\.lib\\.rate** on dev: atom, type -7h\n\n```q\n2\n```");
  const t = readPreview({ found: true, name: ["t"], type: 98, count: { toNumber: () => 100000 }, text: "a b\n---\n0 a\n.." });
  assert.match(previewMarkdown(t, "dev"), /^\*\*t\*\* on dev: table, 100,000 rows\n\n```q\na b\n---\n0 a\n\.\.\n```$/);
  // Cut at the limit, and said so; backticks in the value lengthen the fence.
  const long = readPreview({ found: true, name: "s", type: 10, count: 9000, text: "`".repeat(5) + "x".repeat(PREVIEW_LIMIT) });
  const md = previewMarkdown(long, "dev");
  assert.match(md, /^\*\*s\*\* on dev: vector, type 10h, 9,000 items\n\n``````q\n/);
  assert.match(md, /The first 2,000 characters\.$/);
  // A view and a partitioned table are named, not read.
  assert.strictEqual(previewMarkdown(readPreview({ found: true, name: "v", view: true }), "dev"), "**v** on dev: a view, not evaluated here.");
  assert.match(previewMarkdown(readPreview({ found: true, name: "trade", type: 98, count: 5, text: "" }), "hdb"), /partitioned table, 5 rows\n\nPartitioned: not read\.$/);
  assert.strictEqual(previewMarkdown(readPreview({ found: false }), "dev"), undefined);
  // A label or name is escaped where Markdown would read it.
  assert.match(previewMarkdown(p, "a*b_[x]"), /on a\\\*b\\_\\\[x\\\]:/);
  assert.throws(() => readPreview(42), /something other than a value/);
});

test("only names q could have are sent, space-separated", () => {
  assert.strictEqual(previewNames([".lib.rate", "rate", "a b", "1x", "`s", "x"]), ".lib.rate rate x");
});

test("the switch is declared and off by default", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.liveValueHover.enable"].default, false);
});

/// A hover API that records registrations.
function fakeLanguages() {
  const registered = [];
  vscode.languages = {
    registerHoverProvider: (selector, provider) => {
      const entry = { selector, provider, disposed: false, dispose() { this.disposed = true; } };
      registered.push(entry);
      return entry;
    },
  };
  vscode.Hover = class {
    constructor(contents, range) {
      this.contents = contents;
      this.range = range;
    }
  };
  vscode.Range = class {
    constructor(a, b, c, d) {
      Object.assign(this, { a, b, c, d });
    }
  };
  return registered;
}

function fakeLive(process = { label: "dev", tags: [] }) {
  const sent = [];
  return {
    sent,
    activeProcess: () => process,
    activeLabel: () => process.label,
    borrow(use) {
      return use({ call: async (lambda, names, limit) => (sent.push({ names, limit }), { found: true, name: names.split(" ")[0], type: -7, count: 1, text: "10\n" }) }, process);
    },
  };
}

const document = { uri: { toString: () => "file:///ws/a.q" } };
const position = { line: 2, character: 12 };

test("off, no provider and nothing asked; on, the server names the global and the process is read", async () => {
  stub.reset();
  const registered = fakeLanguages();
  const asked = [];
  const server = { sendRequest: async (method, params) => (asked.push([method, params]), { names: [".lib.rate"], range: { start: { line: 2, character: 11 }, end: { line: 2, character: 15 } } }) };
  const live = fakeLive();
  const hover = registerValueHover(stub.newContext(), live, () => server);
  // Off by default.
  assert.strictEqual(hover.registered(), false);
  assert.strictEqual(registered.length, 0);
  assert.strictEqual(await hover.hover(document, position), undefined);
  assert.deepStrictEqual(asked, []);
  assert.deepStrictEqual(live.sent, []);

  stub.config.user["liveValueHover.enable"] = true;
  stub.changeConfig("q-lint.liveValueHover.enable");
  assert.strictEqual(registered.length, 1);
  assert.deepStrictEqual(registered[0].selector, { language: "q" });
  const shown = await registered[0].provider.provideHover(document, position);
  assert.deepStrictEqual(asked, [[GLOBAL_AT, { textDocument: { uri: "file:///ws/a.q" }, position: { line: 2, character: 12 } }]]);
  assert.deepStrictEqual(live.sent, [{ names: ".lib.rate", limit: 2000 }]);
  assert.match(shown.contents.value, /^\*\*\\\.lib\\\.rate\*\* on dev: atom, type -7h\n\n```q\n10\n```$/);
  assert.deepStrictEqual(shown.range, new vscode.Range(2, 11, 2, 15));

  // A local, or a word of q's: the server names nothing, the process is not asked.
  server.sendRequest = async () => null;
  assert.strictEqual(await hover.hover(document, position), undefined);
  assert.strictEqual(live.sent.length, 1);

  stub.config.user["liveValueHover.enable"] = false;
  stub.changeConfig("q-lint.liveValueHover.enable");
  assert.strictEqual(registered[0].disposed, true);
  assert.strictEqual(hover.registered(), false);
});

test("a production process is not asked, and a busy one shows nothing", async () => {
  stub.reset();
  fakeLanguages();
  stub.config.user["liveValueHover.enable"] = true;
  const server = { sendRequest: async () => ({ names: ["x"], range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }) };
  const prod = fakeLive({ label: "live", tags: ["prod"] });
  const shown = await registerValueHover(stub.newContext(), prod, () => server).hover(document, position);
  assert.match(shown.contents.value, /not read: live is a production process/);
  assert.deepStrictEqual(prod.sent, []);
  // No connection: nothing at all.
  const none = { activeProcess: () => undefined, activeLabel: () => undefined, borrow: () => undefined };
  assert.strictEqual(await registerValueHover(stub.newContext(), none, () => server).hover(document, position), undefined);
  // Connected but busy past the wait: nothing.
  const busy = { activeProcess: () => ({ label: "dev", tags: [] }), activeLabel: () => undefined, borrow: () => undefined };
  assert.strictEqual(await registerValueHover(stub.newContext(), busy, () => server).hover(document, position), undefined);
});

test("a production process connected while the server answered is not read (#1456)", async () => {
  stub.reset();
  stub.config.user["liveValueHover.enable"] = true;
  let active = { label: "dev", tags: [] };
  const asked = [];
  const live = {
    activeProcess: () => active,
    activeLabel: () => active.label,
    borrow: (use) => use({ call: async () => (asked.push(active.label), {}) }, active),
  };
  let release;
  const lsp = { sendRequest: async () => (await new Promise((r) => (release = r)), { names: ["t"], range: null }) };
  const r = registerValueHover(stub.newContext(), live, () => lsp);
  const hover = r.hover({ uri: vscode.Uri.file("/a.q") }, { line: 0, character: 0 });
  await new Promise((r) => setImmediate(r));
  active = { label: "prodrdb", tags: ["prod"] };
  release();
  assert.strictEqual(await hover, undefined);
  assert.deepStrictEqual(asked, []);
});
