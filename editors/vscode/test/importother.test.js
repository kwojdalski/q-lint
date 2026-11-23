// Import from qStudio and KX's extension (#1033): each of their forms read
// (fixtures written as their open-source code writes them: qStudio's
// ConnectionManager/ServerConfigDTO/PreferenceHelper/ConnectionShortFormat,
// KX's serverCommand/connectionManagerService), passwords never taken, and
// the commands through the stand-in `vscode` module, on and off. Nothing
// is sent to a q process.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const pkg = require("../package.json");
const { Live } = require("../out/live.js");
const { ADMIN_COMMANDS, adminOff, readAdmin } = require("../out/admin.js");
const { qStudioPrefsXml, readKxExport, readKxServers, readQStudio, readQStudioLines, readQStudioXml, xmlUnescape } = require("../out/importother.js");
const { ImportOther } = require("../out/importotherview.js");

// As XStream with StaxDriver writes a list, `list>` renamed `serverlist>`.
const XML =
  '<?xml version="1.0" ?><serverlist>' +
  '<ServerConfig name="desk/rdb" username="me" password="hunter2" host="rdb.example.com" port="5010" database="" jdbcType="KDB" clr="-16777216"></ServerConfig>' +
  '<ServerConfig name="pg" username="u" password="p" host="db" port="5432" database="x" jdbcType="POSTGRES"></ServerConfig>' +
  '<ServerConfig name="a &amp; b" username="" password="" host="h" port="5000" database="" jdbcType="KDB" folder="old"/>' +
  "</serverlist>";

// PreferenceHelper.encode: XXX_ENCODED_XXX + base64(DeflaterOutputStream).
const encoded = (text) => "XXX_ENCODED_XXX" + zlib.deflateSync(Buffer.from(text, "utf8")).toString("base64");

test("qStudio's Copy Server List lines: names, folders, types; the password never read", () => {
  const read = readQStudioLines("rdb@localhost:5001:me:secret\r\nfolder/hdb@h2:5002\nh3:5003\nfx/tick:5004\npg@POSTGRES#db:5432\nKDB#h5:5005\nbad");
  assert.deepStrictEqual(read.processes, [
    { label: "rdb", host: "localhost", port: 5001, user: "me", tags: [] },
    { label: "hdb", host: "h2", port: 5002, tags: ["folder"] },
    { label: "h3:5003", host: "h3", port: 5003, tags: [] },
    { label: "tick:5004", host: "tick", port: 5004, tags: ["fx"] },
    { label: "h5:5005", host: "h5", port: 5005, tags: [] },
  ]);
  assert.deepStrictEqual(read.skipped, ["pg: a POSTGRES connection, not kdb", "bad: no host:port"]);
  assert.ok(!JSON.stringify(read).includes("secret"));
});

test("qStudio's <serverlist> XML: kdb servers only, entities read, the password never read", () => {
  assert.strictEqual(xmlUnescape("a &amp; &lt;b&gt; &#65;&#x42;"), "a & <b> AB");
  const read = readQStudioXml(XML);
  assert.deepStrictEqual(read.processes, [
    { label: "rdb", host: "rdb.example.com", port: 5010, user: "me", tags: ["desk"] },
    { label: "a & b", host: "h", port: 5000, tags: ["old"] },
  ]);
  assert.deepStrictEqual(read.skipped, ["pg: a POSTGRES connection, not kdb"]);
  assert.ok(!JSON.stringify(read).includes("hunter2"));
});

test("qStudio's preferences: Java's prefs.xml and a plist, split over CONNECTIONS0.., encoded", () => {
  const value = encoded(XML);
  const cut = [value.slice(0, 40), value.slice(40, 90), value.slice(90)];
  const prefsXml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE map SYSTEM "http://java.sun.com/dtd/preferences.dtd">
<map MAP_XML_VERSION="1.0">
  <entry key="OPEN_DOCS" value="x"/>
  <entry key="CONNECTIONS" value="${cut[0]}"/>
  <entry key="CONNECTIONS0" value="${cut[1]}"/>
  <entry key="CONNECTIONS1" value="${cut[2]}"/>
  <entry key="CONNECTIONS2" value=""/>
</map>`;
  assert.strictEqual(qStudioPrefsXml(prefsXml), XML);
  assert.deepStrictEqual(readQStudio(prefsXml).processes.map((p) => p.label), ["rdb", "a & b"]);
  const plist = `<?xml version="1.0"?><plist><dict><key>CONNECTIONS</key>\n<string>${value}</string></dict></plist>`;
  assert.strictEqual(readQStudio(plist).processes.length, 2);
  // A list still in plain XML; the old encrypted form is said, not guessed.
  assert.strictEqual(qStudioPrefsXml(`<entry key="CONNECTIONS" value="${XML.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"/>`), XML);
  assert.throws(() => qStudioPrefsXml('<entry key="CONNECTIONS" value="XXX_I_AM_ENCRYPTED_XXXabc"/>'), /encrypted/);
  // Other XML is not read as lines.
  assert.deepStrictEqual(readQStudio("<map></map>"), { processes: [], skipped: ["it holds no qStudio server list"] });
});

test("KX's kdb.servers with its labels as tags, and its export file; Insights left out, passwords never read", () => {
  const servers = {
    rdb: { serverName: "localhost", serverPort: "5001", serverAlias: "rdb", auth: true, tls: false },
    tls: { serverName: "secure.example.com", serverPort: "5443", serverAlias: "secure", auth: false, tls: true },
    local: { serverName: "", serverPort: "5002", serverAlias: "local", managed: true },
  };
  const read = readKxServers(servers, [{ labelName: "Prod", connections: ["secure"] }, { labelName: "fx", connections: ["secure", "rdb"] }]);
  assert.deepStrictEqual(read.processes, [
    { label: "rdb", host: "localhost", port: 5001, tags: ["fx"] },
    { label: "secure", host: "secure.example.com", port: 5443, tags: ["prod", "fx"], tls: true },
  ]);
  assert.deepStrictEqual(read.skipped, ["local: A host is needed."]);
  const exported = readKxExport({
    connections: { KDB: [{ serverName: "h", serverPort: "5000", serverAlias: "x", auth: true, tls: false, username: "me", password: "pw" }], Insights: [{ alias: "i", server: "https://x" }] },
  });
  assert.deepStrictEqual(exported.processes, [{ label: "x", host: "h", port: 5000, user: "me", tags: [] }]);
  assert.deepStrictEqual(exported.skipped, ["1 kdb Insights connection(s): not q processes"]);
  assert.ok(!JSON.stringify(exported).includes("pw"));
  assert.throws(() => readKxExport([]), /connections/);
});

test("the switch: on by default, contributed, its commands hidden while off", () => {
  assert.strictEqual(readAdmin((_k, f) => f).importOther, true);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  assert.strictEqual(section.properties["q-lint.processes.importOther.enable"].default, true);
  for (const id of [ADMIN_COMMANDS.importQStudio, ADMIN_COMMANDS.importKx]) {
    assert.ok(pkg.contributes.commands.some((c) => c.command === id && c.category === "q-lint"));
    const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === id);
    assert.strictEqual(menus.length, 2);
    for (const m of menus) assert.match(m.when, /config\.q-lint\.processes\.importOther\.enable/);
  }
});

async function setUp(t, files = {}) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "old", port: 1, tags: [] }]);
  const live = new Live(context);
  new ImportOther(context, live);
  vscode.workspace.fs = { readFile: async (uri) => Buffer.from(files[uri.fsPath] ?? "") };
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live };
}

test("Import Servers from qStudio: from the clipboard, asked, a saved label kept as it is", async (t) => {
  const { live } = await setUp(t);
  vscode.env = { clipboard: { readText: async () => "rdb@new:5001\ntick@t:5000:me:pw" } };
  stub.picks.push("From the clipboard", "Import");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importQStudio)(), 1);
  assert.deepStrictEqual(live.processes(), [
    { label: "rdb", host: "old", port: 1, tags: [] },
    { label: "tick", host: "t", port: 5000, user: "me", tags: [] },
  ]);
  const question = stub.messages.find(([, text]) => /^Import 1 q process/.test(text));
  assert.match(question[1], /tick/);
  // Declined: nothing added.
  vscode.env = { clipboard: { readText: async () => "x@h:1" } };
  stub.picks.push("From the clipboard", undefined);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importQStudio)(), 0);
  assert.strictEqual(live.processes().length, 2);
});

test("Import Servers from qStudio from a preferences file given", async (t) => {
  const { live } = await setUp(t, { "/prefs.xml": `<map><entry key="CONNECTIONS" value="${encoded(XML)}"/></map>` });
  stub.picks.push("Import");
  // Its rdb is saved already, and kept as it is.
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importQStudio)(vscode.Uri.file("/prefs.xml")), 1);
  assert.deepStrictEqual(live.processes().map((p) => [p.label, p.host]), [["rdb", "old"], ["a & b", "h"]]);
});

test("Import Connections from KX Extension: from kdb.servers, and from an export file", async (t) => {
  const { live } = await setUp(t, { "/kx.json": JSON.stringify({ connections: { KDB: [{ serverName: "h", serverPort: "7000", serverAlias: "fromfile" }], Insights: [] } }) });
  stub.config.user["kdb.servers"] = { a: { serverName: "localhost", serverPort: "6000", serverAlias: "kxa" } };
  stub.config.user["kdb.labelsConnectionMap"] = [{ labelName: "dev", connections: ["kxa"] }];
  stub.picks.push("From this VS Code's settings", "Import");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importKx)(), 1);
  assert.deepStrictEqual(live.processes().at(-1), { label: "kxa", host: "localhost", port: 6000, tags: ["dev"] });
  stub.picks.push("Import");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importKx)(vscode.Uri.file("/kx.json")), 1);
  assert.strictEqual(live.processes().at(-1).label, "fromfile");
});

test("turned off, both commands refuse and import nothing; on again without a reload", async (t) => {
  const { live } = await setUp(t);
  stub.config.user["processes.importOther.enable"] = false;
  stub.changeConfig("q-lint.processes.importOther.enable");
  vscode.env = { clipboard: { readText: async () => "x@h:1" } };
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importQStudio)(), 0);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importKx)(), 0);
  assert.deepStrictEqual(stub.messages, [["info", adminOff("importOther")], ["info", adminOff("importOther")]]);
  assert.strictEqual(live.processes().length, 1);
  stub.config.user["processes.importOther.enable"] = true;
  stub.picks.push("From the clipboard", "Import");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importQStudio)(), 1);
});

// The first `@` was taken for the name's end even in the password: part of
// it became the label, saved to settings.json, or was shown in a skip.
test("an @ in a qStudio line's password is not read as the name's end (#1071)", () => {
  const read = readQStudioLines("prodhost:5000:alice:pw@x:1\nprodhost:5001:alice:s3cr@t\nrdb@h:5002:bob:p@ss");
  assert.deepStrictEqual(read.processes.map((p) => [p.label, p.host, p.port, p.user]), [
    ["prodhost:5000", "prodhost", 5000, "alice"],
    ["prodhost:5001", "prodhost", 5001, "alice"],
    ["rdb", "h", 5002, "bob"],
  ]);
  assert.deepStrictEqual(read.skipped, []);
  assert.ok(!JSON.stringify(read).includes("pw") && !JSON.stringify(read).includes("s3cr"));
});
