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

test("a qStudio name repeated in another folder keeps its folder in its label (#1687)", () => {
  const lines = readQStudioLines("desk1/rdb@h1:5000\ndesk2/rdb@h2:5000\nrdb@h3:1");
  assert.deepStrictEqual(lines.processes.map((p) => [p.label, p.host]), [["rdb", "h1"], ["desk2/rdb", "h2"]]);
  assert.deepStrictEqual(lines.skipped, ["rdb: repeats a label"], "with no folder to tell it apart, still skipped");
  const xml = readQStudioXml('<ServerConfig name="rdb" folder="a" host="h" port="1"/><ServerConfig name="rdb" folder="b" host="h2" port="1"/>');
  assert.deepStrictEqual(xml.processes.map((p) => [p.label, p.host]), [["rdb", "h"], ["b/rdb", "h2"]]);
});

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
  // A number no character has is kept as written, not the whole import lost (#1273).
  assert.strictEqual(xmlUnescape("a&#x110000;b&#99999999;c&#0;&#x10FFFF;"), "a&#x110000;b&#99999999;c&#0;\u{10FFFF}");
  const read = readQStudioXml(XML);
  assert.deepStrictEqual(read.processes, [
    { label: "rdb", host: "rdb.example.com", port: 5010, user: "me", tags: ["desk"] },
    { label: "a & b", host: "h", port: 5000, tags: ["old"] },
  ]);
  assert.deepStrictEqual(read.skipped, ["pg: a POSTGRES connection, not kdb"]);
  assert.ok(!JSON.stringify(read).includes("hunter2"));
});

test("a qStudio line's IPv6 host is read in brackets or bare, its colons not the port's (#3114)", () => {
  const read = readQStudioLines(
    ["hdb@[::1]:5001", "rdb@::1:5002", "ok@host:5003", "desk/tp@[fe80::1]:5004:me:se:cret", "fx/[2001:db8::2]:5005", "KDB#[::1]:5006", "u@2001:db8::3:5007:bob:pw", "pg@POSTGRES#[::1]:5432", "bad@[::1]", "worse@::1:port"].join("\n"),
  );
  assert.deepStrictEqual(read.processes, [
    { label: "hdb", host: "::1", port: 5001, tags: [] },
    { label: "rdb", host: "::1", port: 5002, tags: [] },
    { label: "ok", host: "host", port: 5003, tags: [] },
    { label: "tp", host: "fe80::1", port: 5004, user: "me", tags: ["desk"] },
    { label: "[2001:db8::2]:5005", host: "2001:db8::2", port: 5005, tags: ["fx"] },
    { label: "::1:5006", host: "::1", port: 5006, tags: [] },
    { label: "u", host: "2001:db8::3", port: 5007, user: "bob", tags: [] },
  ]);
  assert.deepStrictEqual(read.skipped, ["pg: a POSTGRES connection, not kdb", "bad: no host:port", "worse: A port is a whole number."]);
  assert.ok(!JSON.stringify(read).includes("cret") && !JSON.stringify(read).includes("pw"));
});

test("a > inside a qStudio XML attribute is the attribute's, not the tag's end (#3100)", () => {
  const xml = `<serverlist>
    <ServerConfig name="a>b" host="h1" port="5001" jdbcType="KDB"/>
    <ServerConfig name="orders" host="db1" port="3306" username="u" password="x>y" jdbcType="MYSQL"/>
    <ServerConfig name='c' folder='x>"y"' host="h3" port="5003" password='p>"q' />
    <ServerConfig name="d" host="h4" port="5004"></ServerConfig>
  </serverlist>`;
  const got = readQStudioXml(xml);
  assert.deepStrictEqual(got.processes.map((p) => [p.label, p.host, p.port]), [["a>b", "h1", 5001], ["c", "h3", 5003], ["d", "h4", 5004]]);
  assert.deepStrictEqual(got.skipped, ["orders: a MYSQL connection, not kdb"]);
  assert.ok(!JSON.stringify(got).includes("x>y") && !JSON.stringify(got).includes('p>"q'));
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

// A KX label of several words is one tag, not one a word (#1985): `Non Prod`
// was read as `non` and `prod`, and a UAT process guarded as production.
test("a KX label of several words is one tag; a guarded word in it stays one unless the label says non (#1985)", () => {
  const { guardedBy } = require("../out/guard.js");
  const guard = { enabled: true, tags: ["prod", "prd", "production"] };
  const tags = (labelName, guarded) => {
    const read = readKxServers({ a: { serverName: "h", serverPort: "5000", serverAlias: "p" } }, [{ labelName, connections: ["p"] }], guarded);
    return read.processes[0].tags;
  };
  // Not production, said outright: one tag, as qStudio's folder of the same name gives, and not guarded.
  assert.deepStrictEqual(tags("Non Prod"), ["non-prod"]);
  assert.deepStrictEqual(readQStudioXml('<ServerConfig name="uat1" host="h" port="5000" folder="Non Prod"/>').processes[0].tags, ["non-prod"]);
  assert.deepStrictEqual(tags("  Not   Production "), ["not-production"]);
  assert.deepStrictEqual(tags("Non Prod EU"), ["non-prod-eu"]);
  for (const label of ["Non Prod", "Not Production", "Non Prod EU", "non-prod"]) {
    assert.deepStrictEqual(guardedBy({ tags: tags(label) }, guard), [], label);
  }
  // No guarded word: the one tag.
  assert.deepStrictEqual(tags("London Desk"), ["london-desk"]);
  assert.deepStrictEqual(tags("FX, Spot"), ["fx-spot"]);
  // Production, or what may be: the guarded word stays a tag, and the process guarded.
  assert.deepStrictEqual(tags("Prod EU"), ["prod-eu", "prod"]);
  assert.deepStrictEqual(tags("EU Production"), ["eu-production", "production"]);
  assert.deepStrictEqual(tags("Pre Prod"), ["pre-prod", "prod"]);
  assert.deepStrictEqual(tags("Prod Non Critical"), ["prod-non-critical", "prod"]);
  assert.deepStrictEqual(tags("Non Prod and Prod"), ["non-prod-and-prod", "prod"]);
  assert.deepStrictEqual(tags("NO Prod"), ["no-prod", "prod"]);
  for (const label of ["Prod", "Prod EU", "EU Production", "Pre Prod", "Prod Non Critical", "Non Prod and Prod", "NO Prod", "PRD 2"]) {
    assert.deepStrictEqual(guardedBy({ tags: tags(label) }, guard).length, 1, label);
  }
  // The guard's own tags say which words those are, beside the usual three.
  assert.deepStrictEqual(tags("Live EU"), ["live-eu"]);
  assert.deepStrictEqual(tags("Live EU", ["Live"]), ["live-eu", "live"]);
  assert.deepStrictEqual(tags("Non Live", ["live"]), ["non-live"]);
  assert.deepStrictEqual(tags("Prod EU", ["live"]), ["prod-eu", "prod"]);
  // One word, and several labels, as before.
  assert.deepStrictEqual(tags("Prod"), ["prod"]);
  assert.deepStrictEqual(tags("   "), []);
  const both = readKxServers({ a: { serverName: "h", serverPort: "5000", serverAlias: "p" } }, [
    { labelName: "Prod EU", connections: ["p"] },
    { labelName: "prod", connections: ["p"] },
  ]);
  assert.deepStrictEqual(both.processes[0].tags, ["prod-eu", "prod"]);
});

test("Import Connections from KX Extension reads a label's guarded words by q-lint.processes.readOnlyGuard.tags (#1985)", async (t) => {
  const { live } = await setUp(t);
  stub.config.user["processes.readOnlyGuard.tags"] = ["live"];
  stub.config.user["kdb.servers"] = {
    a: { serverName: "localhost", serverPort: "6000", serverAlias: "kxa" },
    b: { serverName: "localhost", serverPort: "6001", serverAlias: "kxb" },
  };
  stub.config.user["kdb.labelsConnectionMap"] = [
    { labelName: "Live EU", connections: ["kxa"] },
    { labelName: "Non Live", connections: ["kxb"] },
  ];
  stub.picks.push("From this VS Code's settings", "Import");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importKx)(), 2);
  assert.deepStrictEqual(live.processes().slice(-2).map((p) => [p.label, p.tags]), [["kxa", ["live-eu", "live"]], ["kxb", ["non-live"]]]);
});

// A qStudio folder of several words was one tag and nothing more (#2030):
// `Prod EU` gave `prod-eu`, which the guard does not guard, so a production
// process came in unguarded. One rule now reads a KX label and a qStudio
// folder alike.
test("a qStudio folder holding a guarded word keeps it as a tag, at any level, unless it says non (#2030)", () => {
  const { guardedBy } = require("../out/guard.js");
  const guard = { enabled: true, tags: ["prod", "prd", "production"] };
  const line = (folder, guarded) => readQStudioLines(`${folder}/hdb1@host1:5010`, guarded).processes[0].tags;
  const xml = (folder, guarded) => readQStudioXml(`<ServerConfig name="hdb1" host="host1" port="5010" folder="${folder}"/>`, guarded).processes[0].tags;
  const kx = (labelName, guarded) =>
    readKxServers({ a: { serverName: "h", serverPort: "5000", serverAlias: "p" } }, [{ labelName, connections: ["p"] }], guarded).processes[0].tags;
  assert.deepStrictEqual(
    readQStudioLines("Prod EU/hdb1@host1:5010\nprod/hdb2@host2:5011").processes.map((p) => [p.label, p.tags]),
    [["hdb1", ["prod-eu", "prod"]], ["hdb2", ["prod"]]],
  );
  // Production, or what may be: guarded, by the three readers alike.
  const production = {
    "Prod EU": ["prod-eu", "prod"],
    "Prod EU/London": ["prod-eu-london", "prod"],
    "Desk/EU Production/hdb": ["desk-eu-production-hdb", "production"],
    "Pre Prod": ["pre-prod", "prod"],
    "Prod-EU": ["prod-eu", "prod"],
    "prod_eu": ["prod_eu", "prod"],
    "pre-prod": ["pre-prod", "prod"],
    "PRD2": ["prd2", "prd"],
    // A level of its own is not said to be non by the one above it.
    "Non/Prod": ["non-prod", "prod"],
    "Non Prod/Prod": ["non-prod-prod", "prod"],
  };
  for (const [name, tags] of Object.entries(production)) {
    for (const read of [line, xml, kx]) {
      assert.deepStrictEqual(read(name), tags, name);
      assert.strictEqual(guardedBy({ tags: read(name) }, guard).length, 1, name);
    }
  }
  // Not production: said outright, or no word of it.
  const other = {
    "Non Prod": ["non-prod"],
    "non-prod": ["non-prod"],
    "Not Production/London": ["not-production-london"],
    "UAT/Non-Prod EU": ["uat-non-prod-eu"],
    "London Desk": ["london-desk"],
    "products": ["products"],
    "desk": ["desk"],
  };
  for (const [name, tags] of Object.entries(other)) {
    for (const read of [line, xml, kx]) {
      assert.deepStrictEqual(read(name), tags, name);
      assert.deepStrictEqual(guardedBy({ tags: read(name) }, guard), [], name);
    }
  }
  // The guard's own tags, a tag of several words among them.
  for (const read of [line, xml, kx]) {
    assert.deepStrictEqual(read("Live EU"), ["live-eu"]);
    assert.deepStrictEqual(read("Live EU", ["Live"]), ["live-eu", "live"]);
    assert.deepStrictEqual(read("Non Live", ["live"]), ["non-live"]);
    assert.deepStrictEqual(read("Desk/Live EU/West", ["live-eu"]), ["desk-live-eu-west", "live-eu"]);
    assert.deepStrictEqual(read("Prod EU", ["live"]), ["prod-eu", "prod"]);
  }
  // The XML's folder and a folder in the name are each read, and the name with no folder is no tag.
  assert.deepStrictEqual(readQStudioXml('<ServerConfig name="London/hdb1" host="h" port="1" folder="Prod EU"/>').processes[0].tags, ["prod-eu", "prod", "london"]);
  assert.deepStrictEqual(readQStudioXml('<ServerConfig name="Prod EU/London/hdb1" host="h" port="1"/>').processes[0].tags, ["prod-eu-london", "prod"]);
  assert.deepStrictEqual(readQStudioXml('<ServerConfig name="prod hdb" host="h" port="1"/>').processes[0].tags, []);
  // With no name, the folder is on the host.
  assert.deepStrictEqual(readQStudioLines("Prod EU/London/host1:5010").processes[0].tags, ["prod-eu-london", "prod"]);
  // readQStudio hands the guard's tags to whichever form it reads.
  assert.deepStrictEqual(readQStudio("Live EU/x@h:1", ["live"]).processes[0].tags, ["live-eu", "live"]);
  assert.deepStrictEqual(readQStudio('<serverlist><ServerConfig name="x" host="h" port="1" folder="Live EU"/></serverlist>', ["live"]).processes[0].tags, ["live-eu", "live"]);
});

test("Import Servers from qStudio reads a folder's guarded words by q-lint.processes.readOnlyGuard.tags (#2030)", async (t) => {
  const { live } = await setUp(t);
  stub.config.user["processes.readOnlyGuard.tags"] = ["live"];
  vscode.env = { clipboard: { readText: async () => "Live EU/qa@h:5001\nNon Live/qb@h:5002\nProd EU/qc@h:5003" } };
  stub.picks.push("From the clipboard", "Import");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.importQStudio)(), 3);
  assert.deepStrictEqual(live.processes().slice(-3).map((p) => [p.label, p.tags]), [["qa", ["live-eu", "live"]], ["qb", ["non-live"]], ["qc", ["prod-eu", "prod"]]]);
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
