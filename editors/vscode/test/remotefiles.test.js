// The process file browser (#1044): listings and files read, a file cut at
// the cap said so, a binary one not shown - and, through the stand-in
// `vscode` and a fake q: off, the view is gone and nothing is sent; on,
// Browse lists the working directory, a directory is read when expanded and
// a file when opened, with the cap. The q side is remotefiles_q.test.js.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp, heads } = require("./fakeq.js");
const { FILE_LIMIT, LIST_DIRECTORY, LIST_LIMIT, READ_FILE, WORKING_DIRECTORY, fileDocument, joinPath, readFileHead, readListing } = require("../out/remotefiles.js");
const { registerFileBrowser, FILES_VIEW } = require("../out/remotefilesview.js");
const { PROCESS_TOOL_COMMANDS, bytesText } = require("../out/processtools.js");
const pkg = require("../package.json");

test("a listing is read, one entry as atoms, and a file's head with its cut", () => {
  assert.deepStrictEqual(readListing([["a b", "f.txt"], [false, true], [-1, 12], 2]), {
    entries: [
      { name: "a b", file: false, size: -1 },
      { name: "f.txt", file: true, size: 12 },
    ],
    total: 2,
  });
  assert.deepStrictEqual(readListing(["f.q", [true], [3], 1]).entries, [{ name: "f.q", file: true, size: 3 }]);
  assert.deepStrictEqual(readListing([[], [], [], 0]).entries, []);
  assert.throws(() => readListing([["a"], [true, false], [1], 1]), /directory listing/);
  assert.deepStrictEqual(readFileHead([12, "hel", true, 3]), { size: 12, text: "hel", cut: true, shown: 3 });
  assert.deepStrictEqual(readFileHead([0, [], false, 0]).text, "");
  assert.throws(() => readFileHead("x"), /a file/);
  assert.strictEqual(joinPath("/", "tmp"), "/tmp");
  assert.strictEqual(joinPath("/data", "hdb"), "/data/hdb");
});

test("the document says when a file is cut, and does not show a binary one", () => {
  assert.strictEqual(fileDocument("/f", "rdb", { size: 5, text: "hello", cut: false, shown: 5 }), "hello");
  assert.match(fileDocument("/f", "rdb", { size: 50, text: "hello", cut: true, shown: 5 }), /^hello\n\n\/ q-lint: the first 5 of 50 bytes of \/f on rdb/);
  assert.match(fileDocument("/f", "rdb", { size: 9, text: "a\u0000b", cut: false, shown: 3 }), /binary file of 9 bytes; not shown/);
});

test("the switch is declared on, and the view and its commands only where it is", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.processes.fileBrowser.enable"].default, true);
  assert.strictEqual(pkg.contributes.views["q-lint"].find((v) => v.id === FILES_VIEW).when, "config.q-lint.processes.fileBrowser.enable");
  const palette = pkg.contributes.menus.commandPalette;
  assert.match(palette.find((m) => m.command === PROCESS_TOOL_COMMANDS.browseFiles).when, /config\.q-lint\.processes\.fileBrowser\.enable/);
  assert.strictEqual(palette.find((m) => m.command === PROCESS_TOOL_COMMANDS.openProcessFile).when, "false");
});

const answer = (m) => {
  const f = Array.isArray(m) ? m[0] : undefined;
  if (f === WORKING_DIRECTORY) return "/srv/q";
  if (f === LIST_DIRECTORY) return m[1] === "/srv/q" ? [["data", "init.q"], [false, true], [-1, 40], 2] : [["x.csv"], [true], [10], 1];
  if (f === READ_FILE) return [40, "show 1", false, 40];
  return null;
};

test("off, nothing is sent; on, Browse lists, a directory is read when expanded, a file when opened", async (t) => {
  const opened = [];
  require("./vscode_stub.js").vscode.window.showTextDocument = async (d) => void opened.push(d);
  const { q, live, feature } = await setUp(t, { config: { "processes.fileBrowser.enable": false }, answer, register: registerFileBrowser });
  await live.connectTo("rdb");
  const before = q.sent.length;
  assert.strictEqual(feature.tree().open, false);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.browseFiles)("/srv/q"), /process file browser is turned off/);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.openProcessFile)({ process: "rdb", path: "/srv/q/init.q" }), /turned off/);
  assert.strictEqual(q.sent.length, before);

  stub.config.user["processes.fileBrowser.enable"] = true;
  stub.changeConfig("q-lint.processes.fileBrowser.enable");
  // Empty: the working directory.
  stub.inputs.push("");
  const [root] = await stub.commands.get(PROCESS_TOOL_COMMANDS.browseFiles)();
  assert.strictEqual(root.label, "/srv/q");
  assert.deepStrictEqual(q.sent.slice(before), [
    [WORKING_DIRECTORY, 0],
    [LIST_DIRECTORY, "/srv/q", LIST_LIMIT],
  ]);
  assert.deepStrictEqual(root.children.map((c) => [c.label, c.icon, c.description ?? ""]), [
    ["data", "folder", ""],
    ["init.q", "file", "40 B"],
  ]);
  // A directory is read only when expanded.
  assert.strictEqual(q.sent.length, before + 2);
  const kids = await root.children[0].load();
  assert.deepStrictEqual(kids.map((k) => k.label), ["x.csv"]);
  assert.deepStrictEqual(q.sent[before + 2], [LIST_DIRECTORY, "/srv/q/data", LIST_LIMIT]);
  // A file, capped.
  const text = await stub.commands.get(PROCESS_TOOL_COMMANDS.openProcessFile)(root.children[1]);
  assert.strictEqual(text, "show 1");
  assert.deepStrictEqual(q.sent[before + 3], [READ_FILE, "/srv/q/init.q", FILE_LIMIT]);
  assert.strictEqual(opened.length, 1);

  stub.config.user["processes.fileBrowser.enable"] = false;
  stub.changeConfig("q-lint.processes.fileBrowser.enable");
  assert.strictEqual(feature.tree().open, false);
  await assert.rejects(root.children[0].load(), /turned off/);
});

test("connected elsewhere while a busy process was waited for, the other's files are not read (#1457)", async () => {
  stub.reset();
  stub.config.user["processes.fileBrowser.enable"] = true;
  let active = "rdb";
  let busy = true;
  const sent = [];
  const live = {
    activeLabel: () => active,
    activeProcess: () => ({ label: active, tags: [] }),
    onDidChange: () => ({ dispose() {} }),
    borrow: (use) => (busy ? undefined : use({ call: async (...a) => (sent.push([active, ...a]), "/srv/other") }, { label: active, tags: [] })),
  };
  const context = stub.newContext();
  const feature = registerFileBrowser(context, live);
  const browsed = feature.browse();
  await new Promise((r) => setImmediate(r));
  active = "other";
  busy = false;
  assert.match(await browsed, /could not list the working directory on rdb: rdb is no longer the active process/);
  assert.deepStrictEqual(sent, []);
  for (const d of context.subscriptions) d.dispose?.();
});

test("a file's size picks its unit after rounding: just under 1 MB is 1.0 MB, not 1024 KB (#1656)", () => {
  assert.strictEqual(bytesText(1048575), "1.0 MB");
  assert.strictEqual(bytesText(1023), "1023 B");
  assert.strictEqual(bytesText(1536), "1.5 KB");
  assert.strictEqual(bytesText(-1), "");
});
