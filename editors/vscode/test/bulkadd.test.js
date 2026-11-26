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

test("a q handle is read in q's order, its password never; a four-field line says how it was read (#3098)", () => {
  assert.deepStrictEqual(colonParts("`:prodhost:5010:bob:hunter2"), { host: "prodhost", port: "5010", user: "bob", password: true });
  assert.deepStrictEqual(colonParts(":prodhost:5010:bob"), { host: "prodhost", port: "5010", user: "bob" });
  assert.deepStrictEqual(colonParts("`::5010"), { host: "localhost", port: "5010" });
  assert.deepStrictEqual(colonParts("`:[::1]:5010::pw:with:colons"), { host: "[::1]", port: "5010", password: true });
  assert.strictEqual(colonParts(""), undefined);
  const rows = parseBulk("`:prodhost:5010:bob:hunter2\n:h2:5011:alice\n`::5012\n`:h:99999:bob:hunter3\nprodhost:5013:bob:hunter2\nh:5014:rdb", []);
  assert.deepStrictEqual(rows.map((r) => r.process), [
    { label: "prodhost:5010", host: "prodhost", port: 5010, user: "bob", tags: [] },
    { label: "h2:5011", host: "h2", port: 5011, user: "alice", tags: [] },
    { label: "localhost:5012", host: "localhost", port: 5012, tags: [] },
    undefined,
    { label: "bob", host: "prodhost", port: 5013, tags: ["hunter2"] },
    { label: "rdb", host: "h", port: 5014, tags: [] },
  ]);
  assert.deepStrictEqual(rows.map(rowStatus), [
    "added; its password was not read: it is asked for on connect",
    "added",
    "added",
    "A port is between 1 and 65535.",
    // The same line without its `: is a label and a tag, and says so.
    "added; labelled bob, tagged hunter2",
    "added",
  ]);
  // A handle's password is in no row, nor in the table, even of a line refused.
  assert.deepStrictEqual([rows[0].text, rows[3].text], ["`:prodhost:5010:bob:***", "`:h:99999:bob:***"]);
  assert.ok(!JSON.stringify(rows).includes("hunter3") && !rowsHtml(rows).includes("hunter3"));
  assert.ok(!JSON.stringify(rows[0]).includes("hunter2"));
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

test("a tls cell is yes or no in a word known to be one, and any other is a row not added (#3099)", () => {
  const cells = ["on", "TRUE", "t", "tls", "enabled", "yes", " Y ", "1", "0", "No", "off", "", "false", "disabled", "maybe", "2", "tls1.3"];
  const rows = parseBulk(`label,host,port,tls\n${cells.map((c, i) => `p${i},h,${5000 + i},${c}`).join("\n")}`, []);
  assert.deepStrictEqual(
    rows.map((r) => (r.process === undefined ? r.problem : r.process.tls === true)),
    [
      ...[true, true, true, true, true, true, true, true],
      ...[false, false, false, false, false, false],
      'tls is "maybe", not yes or no (true, false, 1, 0, on, off), so it was not added rather than connected to without TLS.',
      'tls is "2", not yes or no (true, false, 1, 0, on, off), so it was not added rather than connected to without TLS.',
      'tls is "tls1.3", not yes or no (true, false, 1, 0, on, off), so it was not added rather than connected to without TLS.',
    ],
  );
  assert.strictEqual(toAdd(rows).length, 14);
  // No tls column, and a line that is not CSV: no TLS, as before.
  assert.deepStrictEqual(parseBulk("host,port\nh,1\n", [])[0].process, { label: "h:1", host: "h", port: 1, tags: [] });
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

test("Add with lines skipped keeps the form open with only those lines in it (#2506)", async (t) => {
  const { live, bulk } = await setUp(t);
  const posted = [];
  bulk.panel = { webview: { postMessage: async (m) => posted.push(m) }, dispose() { bulk.panel = undefined; } };
  await bulk.handle({ type: "add", text: "tp1.example.com:5010:tp1:prod\nrdb1.example.com:50x2:rdb1:prod\n# c\nhdb1.example.com:5012:hdb1" });
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["rdb", "tp1", "hdb1"]);
  assert.ok(bulk.panel !== undefined, "the form stays open");
  assert.deepStrictEqual(posted.at(-1), { type: "text", text: "rdb1.example.com:50x2:rdb1:prod" });
  // CSV: the header stays above the line left.
  const { leftOver, parseBulk } = require("../out/bulkadd.js");
  const csv = "host,port,label\na,1,x\nb,zz,y";
  assert.strictEqual(leftOver(csv, parseBulk(csv, [])), "host,port,label\nb,zz,y");
  assert.strictEqual(leftOver("a:1:x", parseBulk("a:1:x", [])), "");
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
