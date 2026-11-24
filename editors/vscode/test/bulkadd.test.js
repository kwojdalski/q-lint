// Add Many Processes (#1032): lines and CSV read as processes, duplicates
// found, the form's table escaped, and the command through the stand-in
// `vscode` module, on and off. Nothing here talks to a q process: the
// feature sends nothing to one.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { Live } = require("../out/live.js");
const { ADMIN_COMMANDS, adminOff, readAdmin } = require("../out/admin.js");
const { colonParts, csvFields, parseBulk, rowStatus, rowsHtml, toAdd } = require("../out/bulkadd.js");
const { BulkAdd, bulkAddHtml } = require("../out/bulkaddview.js");
const vm = require("node:vm");

const saved = [{ label: "rdb", host: "h1", port: 5010, tags: [] }];

test("host:port[:label[:tags]] lines, an IPv6 host in brackets", () => {
  assert.deepStrictEqual(colonParts("h:5000"), { host: "h", port: "5000" });
  assert.deepStrictEqual(colonParts("[::1]:5000:local:dev,x"), { host: "[::1]", port: "5000", label: "local", tags: "dev,x" });
  const rows = parseBulk("localhost:5001\n# a comment\n\n/ q comment\ntick.example.com:5000:tp:prod torq\n[::1]:6000:six", saved);
  assert.deepStrictEqual(
    rows.map((r) => r.process),
    [
      { label: "localhost:5001", host: "localhost", port: 5001, tags: [] },
      { label: "tp", host: "tick.example.com", port: 5000, tags: ["prod", "torq"] },
      { label: "six", host: "::1", port: 6000, tags: [] },
    ],
  );
  assert.deepStrictEqual(rows.map((r) => r.line), [1, 5, 6]);
});

test("bad lines say why; duplicates of saved or earlier labels are skipped; a shared address is noted", () => {
  const rows = parseBulk("nohost\nh:99999\nh:5000:rdb\nh:5001:a\nh2:5002:a\nh1:5010:other", saved);
  assert.deepStrictEqual(rows.map(rowStatus), [
    "Not host:port[:label[:tags]].",
    "A port is between 1 and 65535.",
    "rdb is already in the list: skipped",
    "added",
    "a is on an earlier line: skipped",
    "added; rdb is at the same address",
  ]);
  assert.deepStrictEqual(toAdd(rows).map((p) => p.label), ["a", "other"]);
});

test("a host that differs from a saved one only in case is the same address (#1813)", () => {
  const rows = parseBulk("H1:5010:r3", saved);
  assert.deepStrictEqual(rows.map(rowStatus), ["added; rdb is at the same address"]);
});

test("CSV with a header row: columns in any order, quoted fields, tags, user and tls; never a password", () => {
  assert.deepStrictEqual(csvFields('a,"b, c","d ""q"""'), ["a", "b, c", 'd "q"']);
  const rows = parseBulk('Port,Host,Label,Tags,User,TLS,Password\n5000,h,"x, y",prod;uat,me,yes,secret\n5001,h,,,,no,', []);
  assert.deepStrictEqual(rows.map((r) => r.process), [
    { label: "x, y", host: "h", port: 5000, user: "me", tags: ["prod", "uat"], tls: true },
    { label: "h:5001", host: "h", port: 5001, tags: [] },
  ]);
  assert.ok(!JSON.stringify(rows).includes("secret"));
});

test("the table escapes what was pasted, and the page runs only its own script", () => {
  const html = rowsHtml(parseBulk('h:5000:<img src=x onerror=alert(1)>:"t"\n<script>', []));
  assert.ok(!html.includes("<img") && !html.includes("<script>"));
  assert.match(html, /&#60;img/);
  assert.match(html, /1 process to add/);
  assert.match(rowsHtml([]), /Nothing to add/);
  const page = bulkAddHtml("vscode-resource:");
  assert.match(page, /default-src 'none'/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(page)[1];
  for (const tag of page.match(/<script[^>]*>/g)) assert.ok(tag.includes(`nonce="${nonce}"`));
});

test("the switch: on by default, contributed, its command hidden while off", () => {
  assert.strictEqual(readAdmin((_k, f) => f).bulkAdd, true);
  assert.strictEqual(readAdmin(() => false).bulkAdd, false);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  assert.strictEqual(section.properties["q-lint.processes.bulkAdd.enable"].default, true);
  assert.ok(pkg.contributes.commands.some((c) => c.command === ADMIN_COMMANDS.bulkAdd && c.category === "q-lint"));
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === ADMIN_COMMANDS.bulkAdd);
  assert.strictEqual(menus.length, 2);
  for (const m of menus) assert.match(m.when, /config\.q-lint\.processes\.bulkAdd\.enable/);
});

async function setUp(t) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", saved);
  const live = new Live(context);
  const bulk = new BulkAdd(context, live);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, bulk };
}

test("the command adds what the text gives, after the saved ones, skipping duplicates", async (t) => {
  const { live } = await setUp(t);
  const added = await stub.commands.get(ADMIN_COMMANDS.bulkAdd)("a:1:one:dev\nb:2:rdb\nc:3:two");
  assert.strictEqual(added, 2);
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["rdb", "one", "two"]);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: added 2 q process(es); skipped 1 line(s)."]);
  // Nothing new: nothing saved.
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.bulkAdd)("a:1:one"), 0);
  assert.strictEqual(live.processes().length, 3);
});

test("the form's messages: a check is answered with the table, Add adds", async (t) => {
  const { live, bulk } = await setUp(t);
  const posted = [];
  bulk.panel = { webview: { postMessage: async (m) => posted.push(m) }, dispose() { bulk.panel = undefined; } };
  await bulk.handle({ type: "check", text: "x:1:rdb" });
  assert.match(posted[0].html, /already in the list/);
  await bulk.handle({ type: "add", text: "x:1:new" });
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["rdb", "new"]);
  assert.strictEqual(bulk.panel, undefined);
});

// The panel does not keep its page while hidden, and the page kept what
// was typed only in its text area: another tab looked at, the form came
// back empty (#1990).
test("the form's text survives its tab being hidden: the page keeps it in its state and checks it again", () => {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(bulkAddHtml("vscode-resource:"))[1];
  // The page loaded afresh, as it is each time the tab is shown, over the state VS Code keeps for the panel.
  let state;
  const load = () => {
    const posted = [];
    const element = () => ({ value: "", innerHTML: "", on: {}, addEventListener(type, f) { this.on[type] = f; } });
    const elements = { text: element(), rows: element(), add: element() };
    vm.runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => state, setState: (s) => (state = s) }),
      document: { getElementById: (id) => elements[id] },
      window: element(),
    });
    return { ...elements, posted };
  };
  const first = load();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first.posted)), [{ type: "check", text: "" }]);
  first.text.value = "localhost:5010:rdb:dev\ntick:5000";
  first.text.on.input();
  const shown = load();
  assert.strictEqual(shown.text.value, "localhost:5010:rdb:dev\ntick:5000");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(shown.posted)), [{ type: "check", text: "localhost:5010:rdb:dev\ntick:5000" }]);
  shown.add.on.click();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(shown.posted.at(-1))), { type: "add", text: "localhost:5010:rdb:dev\ntick:5000" });
});

test("turned off, the command refuses and adds nothing; on again without a reload", async (t) => {
  const { live } = await setUp(t);
  stub.config.user["processes.bulkAdd.enable"] = false;
  stub.changeConfig("q-lint.processes.bulkAdd.enable");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.bulkAdd)("a:1:one"), 0);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.bulkAdd)(), undefined);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", adminOff("bulkAdd")]);
  assert.match(adminOff("bulkAdd"), /q-lint\.processes\.bulkAdd\.enable/);
  assert.strictEqual(live.processes().length, 1);
  stub.config.user["processes.bulkAdd.enable"] = true;
  stub.changeConfig("q-lint.processes.bulkAdd.enable");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.bulkAdd)("a:1:one"), 1);
});
