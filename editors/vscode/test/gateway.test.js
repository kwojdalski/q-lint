// TorQ gateways (#909): how a query is put in `.gw.syncexec`, the setting
// and commands, and the queries themselves against real q processes - an
// rdb, an hdb and a gateway defining `.gw.syncexec` over handles to them as
// TorQ's does - when QLINT_TEST_Q names a q binary.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const pkg = require("../package.json");
const { GATEWAY_COMMANDS, fileServerTypes, gatewayParts, gatewayStatement, gatewayStatements, isGatewayCall, isGatewayOwn, joined, readGateway, symbols, withServerTypes } = require("../out/gateway.js");
const { statements } = require("../out/statements.js");
const { qString } = require("../out/qliteral.js");
const { givenServerTypes, parseProcesses, serverTypes } = require("../out/processes.js");
const { Live } = require("../out/live.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a query is a q string, several statements one string joined on `;` lines (#2492, #2591)", () => {
  assert.strictEqual(qString('a:"x\\y"\n\tb'), '"a:\\"x\\\\y\\"\\n\\tb"');
  assert.strictEqual(qString("1"), 'enlist "1"');
  assert.strictEqual(qString("\x01é"), '"\\001é"');
  assert.strictEqual(symbols(["rdb"]), "enlist `rdb");
  assert.strictEqual(symbols(["rdb", "hdb"]), "`rdb`hdb");
  assert.strictEqual(gatewayStatement(["select from trade"], ["rdb", "hdb"]), '.gw.syncexec["select from trade";`rdb`hdb]');
  assert.strictEqual(gatewayStatement(["n:1 / one", "n+1"], ["hdb"]), '.gw.syncexec["n:1 / one\\n ;n+1";enlist `hdb]');
  // A system command cannot be followed on its line, so it is `system`.
  assert.strictEqual(joined(["\\l f.q", "f:{x+\n 1}", "f 1"]), 'system "l f.q"\n ;f:{x+\n 1}\n ;f 1');
  assert.ok(isGatewayCall('.gw.syncexec["1";`rdb]'));
  assert.ok(!isGatewayCall("select from trade"));
  // TorQ's typed and timed variants are gateway calls too (#1427).
  assert.ok(isGatewayCall('.gw.syncexecj["q";`rdb;raze]'));
  assert.ok(isGatewayCall('.gw.asyncexecjpt["q";`rdb;raze;();0D00:01]'));
  // Any name of the gateway's own is its code (#2588); one in another
  // namespace is not.
  assert.ok(isGatewayCall(".gw.syncexec_x[1]"));
  assert.ok(!isGatewayCall("gw.syncexec[1]"));
  assert.ok(!isGatewayCall("my.gw.syncexec[1]"));
});

// A call the user wrote and assigned or applied is not wrapped again: the
// servers have no `.gw` (#2361). Nor is the gateway's own API and state,
// meant to run on the gateway (#2588).
test("a gateway call anywhere in a statement, and the gateway's own API, are the gateway's code (#2361, #2588)", () => {
  assert.ok(isGatewayCall('t:.gw.syncexec["select from trade";`rdb]'));
  assert.ok(isGatewayCall('count .gw.syncexec["select from trade";`rdb]'));
  assert.ok(isGatewayCall("f:{.gw.syncexec[x;`rdb]}"));
  assert.ok(isGatewayCall("`.gw.syncexec . (\"1\";`rdb)"));
  assert.ok(isGatewayCall(".gw.servers"));
  assert.ok(isGatewayCall("select from .gw.servers where servertype=`rdb"));
  assert.ok(isGatewayCall(".dataaccess.getdata[`tablename`aggregations!(`trade;enlist[`avg]!enlist`px)]"));
  // A string or a comment naming one is not.
  assert.ok(!isGatewayCall('s:".gw.servers"'));
  assert.ok(!isGatewayCall("count trade / not .gw.servers"));
  assert.ok(!isGatewayCall("select from trade where time>2024.01.01D00:00"));
});

test("a file names its server types on a `/ @servertypes` line", () => {
  assert.deepStrictEqual(fileServerTypes("/ @servertypes rdb hdb\nselect from t"), ["rdb", "hdb"]);
  assert.deepStrictEqual(fileServerTypes("a:1\n/@servertypes `hdb,rdb\n"), ["hdb", "rdb"]);
  assert.strictEqual(fileServerTypes("  / @servertypes rdb\n"), undefined);
  assert.strictEqual(fileServerTypes("/ @servertypes 1x\n"), undefined);
  // A comment after them is no more types (#2587).
  assert.deepStrictEqual(fileServerTypes("/ @servertypes rdb hdb / the live and history ones\nselect from t"), ["rdb", "hdb"]);
  assert.deepStrictEqual(fileServerTypes("/ @servertypes `rdb`hdb  - both\n"), ["rdb", "hdb"]);
  // `none`: the gateway itself (#2588).
  assert.deepStrictEqual(fileServerTypes("/ @servertypes none\n.gw.servers"), []);
  assert.deepStrictEqual(serverTypes("rdb, hdb rdb"), ["rdb", "hdb"]);
  assert.strictEqual(serverTypes(""), undefined);
  // Read from every source, a discovery server's too: it runs nothing new.
  assert.deepStrictEqual(parseProcesses([{ label: "gw", host: "h", port: 1, gateway: ["rdb"] }]).processes[0].gateway, ["rdb"]);
});

// The editor context menu hands in the editor's Uri: taken as types, it
// named none, and the command refused every time instead of asking (#1522).
test("a Uri handed in from a menu is no server types, so they are asked for", () => {
  assert.strictEqual(givenServerTypes({ scheme: "file", fsPath: "/w/a.q" }), undefined);
  assert.strictEqual(givenServerTypes(undefined), undefined);
  assert.strictEqual(givenServerTypes("rdb"), "rdb");
  assert.deepStrictEqual(givenServerTypes(["rdb", "hdb"]), ["rdb", "hdb"]);
});

test("the setting is on by default, and hides the gateway commands when off", () => {
  assert.deepStrictEqual(readGateway((_k, f) => f), { enabled: true });
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process connections");
  assert.strictEqual(section.properties["q-lint.connection.torqGateway.enable"].default, true);
  for (const command of Object.values(GATEWAY_COMMANDS)) {
    const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === command);
    assert.match(palette.when, /config\.q-lint\.connection\.torqGateway\.enable/, command);
    for (const m of Object.values(pkg.contributes.menus).flat().filter((m) => m.command === command)) {
      assert.match(m.when, /config\.q-lint\.connection\.torqGateway\.enable/, `${command} ${m.when}`);
    }
  }
});

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-gw-"));
  fs.writeFileSync(path.join(dir, "s.q"), body);
  const port = await freePort();
  const child = spawn(`${Q} ${path.join(dir, "s.q")} -p ${port}`, { shell: true, stdio: "ignore", detached: true });
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) return port;
    await sleep(100);
  }
  throw new Error("q did not start");
}

/// An rdb, an hdb and a gateway over them, as TorQ's: `.gw.syncexec` runs
/// the query on a server of each type and razes what they answer. As
/// TorQ's on kdb+ 3.6 and later (`syncexecjt`, `processes/gateway.q`), it
/// defers its reply with `-30!(::)` and sends the joined result, or the
/// error, from a timer with `-30!(handle;error;result)`: whatever the
/// message that called it would have answered is discarded (#2584). Each
/// server gets the query as TorQ sends it, `value`d - through `.pm.valp`
/// where the server defines one, as TorQ's read-only mode does (#2591).
/// `servers` adds code to the rdb and the hdb.
async function torq(t, servers = "") {
  const rdb = await startQ(t, `trade:([] sym:\`a\`b; px:1 2f)\n${servers}\n`);
  const hdb = await startQ(t, `trade:([] sym:\`c\`d\`e; px:3 4 5f)\n${servers}\n`);
  const gw = await startQ(
    t,
    [
      `.gw.h:\`rdb\`hdb!(hopen \`::${rdb};hopen \`::${hdb})`,
      ".gw.servers:([] servertype:`rdb`hdb)",
      ".servers.SERVERS:([] procname:`rdb1`hdb1; proctype:`rdb`hdb)",
      "role:`gateway",
      ".gw.run:{[query;servertypes;join] servertypes,:(); if[count m:servertypes except key .gw.h; '\"not all of the requested server types are available: \",\",\" sv string m]; join .gw.h[servertypes]@\\:({$[`.pm.valp~key`.pm.valp;.pm.valp x;value x]};query)}",
      ".gw.replies:()",
      ".gw.syncexecj:{[query;servertypes;join] -30!(::); .gw.replies,:enlist (.z.w;@[{(0b;.gw.run . x)};(query;servertypes;join);{(1b;x)}]); }",
      ".gw.syncexec:.gw.syncexecj[;;raze]",
      ".z.ts:{r:.gw.replies; .gw.replies:(); {-30!(x 0;x[1]0;x[1]1)} each r}",
      "\\t 5",
      "",
    ].join("\n"),
  );
  return gw;
}

async function setUp(t, processes) {
  stub.reset();
  const vscode = require("vscode");
  const lines = [];
  const make = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = () => ({ appendLine: (l) => lines.push(...l.split("\n")), clear: () => (lines.length = 0), show() {}, dispose() {} });
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  vscode.window.createOutputChannel = make;
  const editor = (text) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text: text.split("\n")[0] }), getText: () => text },
      selection: { active: { line: 0 }, isEmpty: true },
    };
  };
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  const query = async (text, command = "q-lint.queryCurrentLine", ...args) => {
    editor(text);
    lines.length = 0;
    await stub.commands.get(command)(...args);
    const h = live.history()[0];
    return { code: h.code, outcome: h.outcome, text: lines.slice(1).join("\n").trim() };
  };
  return { live, query, lines };
}

test("a query to a TorQ gateway goes through .gw.syncexec to the server types asked for", { skip }, async (t) => {
  const gw = await torq(t);
  const { live, query } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  // The process's own server types: both servers' rows, joined.
  let r = await query("exec sym from trade");
  assert.deepStrictEqual(r, { code: '.gw.syncexec["exec sym from trade";`rdb`hdb]', outcome: "ok", text: "`a`b`c`d`e" });
  // A file's, on its `/ @servertypes` line.
  r = await query("exec sym from trade\n/ @servertypes hdb");
  assert.strictEqual(r.text, "`c`d`e");
  // A query's, asked for: the box starts from the file's.
  stub.inputs.push((o) => (assert.strictEqual(o.value, "hdb"), "rdb"));
  r = await query("exec sym from trade\n/ @servertypes hdb", GATEWAY_COMMANDS.queryWith);
  assert.deepStrictEqual(r, { code: '.gw.syncexec["exec sym from trade";enlist `rdb]', outcome: "ok", text: "`a`b" });
  // A gateway's own error is q's error, as any query's.
  r = await query("exec sym from trade", GATEWAY_COMMANDS.queryWith, "rtd");
  assert.strictEqual(r.outcome, "error");
  // Run again from the history, it is not wrapped twice.
  await stub.commands.get("q-lint.rerunQuery")(live.history().find((h) => h.code.includes("enlist `rdb]")));
  assert.deepStrictEqual(live.history()[0].code, '.gw.syncexec["exec sym from trade";enlist `rdb]');
  assert.strictEqual(live.history()[0].outcome, "ok");
  // That entry queried on other server types goes to them (#2592).
  r = await query('.gw.syncexec["exec sym from trade";enlist `rdb]', GATEWAY_COMMANDS.queryWith, "hdb");
  assert.deepStrictEqual(r, { code: '.gw.syncexec["exec sym from trade";enlist `hdb]', outcome: "ok", text: "`c`d`e" });
  // A call of another shape keeps its own, and says so.
  stub.messages = [];
  r = await query('t:.gw.syncexec["exec sym from trade";`rdb]', GATEWAY_COMMANDS.queryWith, "hdb");
  assert.strictEqual(r.code, 't:.gw.syncexec["exec sym from trade";`rdb]');
  assert.match(stub.messages.at(-1)[1], /goes to the server types it names, not hdb/);
});

test("a result's gateway call gives the query inside it and its server types (#2436, #2437)", () => {
  assert.deepStrictEqual(gatewayParts('.gw.syncexec["count trade";enlist `hdb]'), { query: "count trade", types: ["hdb"] });
  const query = 's:"a\\"b\\\\c\tdé\001"\nselect from trade';
  assert.deepStrictEqual(gatewayParts(gatewayStatement([query], ["rdb", "hdb"])), { query, types: ["rdb", "hdb"] });
  assert.deepStrictEqual(gatewayParts('.gw.syncexec[enlist "1";`rdb]'), { query: "1", types: ["rdb"] });
  assert.strictEqual(gatewayParts("select from trade"), undefined);
  assert.strictEqual(gatewayParts('t:.gw.syncexec["1";`rdb]'), undefined);
});

test("a recorded gateway call is sent to other server types (#2592)", () => {
  assert.strictEqual(withServerTypes('.gw.syncexec["count trade";enlist `rdb]', ["hdb", "rdb"]), '.gw.syncexec["count trade";`hdb`rdb]');
  assert.strictEqual(withServerTypes('.gw.syncexec["a:\\"x;y]\\"\\n ;a";`rdb`hdb]', ["hdb"]), '.gw.syncexec["a:\\"x;y]\\"\\n ;a";enlist `hdb]');
  assert.strictEqual(withServerTypes('t:.gw.syncexec["count trade";`rdb]', ["hdb"]), undefined);
  assert.strictEqual(withServerTypes('.gw.syncexec[q;`rdb]', ["hdb"]), undefined);
  assert.strictEqual(withServerTypes('.gw.syncexec["1";`rdb]\n.gw.syncexec["2";`rdb]', ["hdb"]), undefined);
});

test("several statements go to each server as one string", { skip }, async (t) => {
  const gw = await torq(t);
  const { live, lines } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  lines.length = 0;
  await live.run("n:count trade / rows\nn*10");
  // Each server's last value, joined: 2 rows on the rdb, 3 on the hdb.
  assert.deepStrictEqual(lines.slice(1), ["20 30"]);
  assert.deepStrictEqual(live.history()[0], { ...live.history()[0], code: '.gw.syncexec["n:count trade / rows\\n ;n*10";`rdb`hdb]', outcome: "ok" });
});

// TorQ's read-only mode runs each query as `reval parse x`, which refuses
// anything but a string with 'type (#2591); a direct connection promises
// nothing of q-lint's is sent, a lambda neither (#2492).
test("several statements reach a read-only TorQ server as one string, on a direct connection too (#2492, #2591)", { skip }, async (t) => {
  const gw = await torq(t, ".pm.valp:{reval parse x}");
  for (const evaluation of [undefined, "direct"]) {
    const { live, lines } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"], ...(evaluation ? { evaluation } : {}) }]);
    assert.strictEqual(await live.connectTo("gw"), true);
    lines.length = 0;
    await live.run("count trade / rows first\nexec max px from trade");
    assert.deepStrictEqual([live.history()[0].outcome, lines.slice(1)], ["ok", ["2 5f"]], String(evaluation));
    assert.strictEqual(live.history()[0].code, '.gw.syncexec["count trade / rows first\\n ;exec max px from trade";`rdb`hdb]');
    await stub.commands.get("q-lint.disconnectProcess")?.();
  }
});

test("a gateway call written by hand, and the gateway's own API and state, run on the gateway (#2361, #2588)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live, query } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  let r = await query('t:.gw.syncexec["exec sym from trade";`rdb]');
  assert.deepStrictEqual([r.code, r.outcome], ['t:.gw.syncexec["exec sym from trade";`rdb]', "ok"]);
  r = await query("exec servertype from .gw.servers");
  assert.deepStrictEqual(r, { code: "exec servertype from .gw.servers", outcome: "ok", text: "`rdb`hdb" });
  // A file can send its queries to the gateway itself.
  r = await query("role\n/ @servertypes none");
  assert.deepStrictEqual(r, { code: "role", outcome: "ok", text: "`gateway" });
});

// Every TorQ process keeps discovery state of its own, and a server's is
// not the gateway's: sent on, the rdb answered with the tickerplant it
// knows, shown as what the gateway had found (#3058).
test("a read of the state a gateway keeps as any TorQ process does - .servers, .clients, .timer - and .kxdash stay on the gateway (#3058)", () => {
  assert.ok(isGatewayOwn("select from .servers.SERVERS where proctype=`hdb"));
  assert.ok(isGatewayOwn(".servers.getservers[`proctype;`hdb;()!();1b;0b]"));
  assert.ok(isGatewayOwn(".kxdash.dashexec[\"select from trade\";`rdb;raze]"));
  assert.ok(isGatewayOwn("count .clients.clients"));
  assert.ok(isGatewayOwn("select from .timer.timer where active"));
  assert.ok(isGatewayOwn(".gw.servers"));
  // They defer no reply, so they are no gateway call: sent as any query.
  assert.ok(!isGatewayCall("select from .servers.SERVERS where proctype=`hdb"));
  // A query for the servers that reads TorQ's clock is still theirs, as is
  // a name in a string, a comment or another namespace.
  assert.ok(!isGatewayOwn("select from trade where time>.proc.cp[]-0D00:05"));
  assert.ok(!isGatewayOwn('s:".servers.SERVERS"'));
  assert.ok(!isGatewayOwn("count trade / not .servers.SERVERS"));
  assert.ok(!isGatewayOwn("my.servers.SERVERS"));
});

test("a gateway's own discovery state is read on the gateway, not on a server (#3058)", { skip }, async (t) => {
  const gw = await torq(t, ".servers.SERVERS:([] procname:enlist `tp1; proctype:enlist `tickerplant)");
  const { live, query } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  let r = await query("exec procname from .servers.SERVERS where proctype=`hdb");
  assert.deepStrictEqual(r, { code: "exec procname from .servers.SERVERS where proctype=`hdb", outcome: "ok", text: ",`hdb1" });
  // Asked for on server types, it still runs on the gateway, and says so.
  stub.messages = [];
  r = await query("exec procname from .servers.SERVERS", GATEWAY_COMMANDS.queryWith, "rdb");
  assert.deepStrictEqual([r.code, r.text], ["exec procname from .servers.SERVERS", "`rdb1`hdb1"]);
  assert.match(stub.messages.at(-1)[1], /reads the gateway's own state, so it runs on the gateway itself, not on rdb\./);
  // Written out, the call sends it to them.
  r = await query('.gw.syncexec["exec procname from .servers.SERVERS";`rdb]');
  assert.strictEqual(r.text, ",`tp1");
});

// q parses a string whole before it runs any of it: in one string, the
// functions after a `\d .stats` were bound to the root, and `wide`'s call of
// `mid` failed with 'mid, or found a `mid` of the root (#3057).
test("statements that switch the context are strings valued one by one, each in the context before it (#3057)", () => {
  assert.strictEqual(joined(["\\d .x", "f:{x+\n 1}", "f 1"]), 'last value each ("system \\"d .x\\"";"f:{x+\\n 1}";"f 1")');
  assert.strictEqual(joined(['system "d .x"', "1"]), 'last value each ("system \\"d .x\\"";enlist "1")');
  assert.strictEqual(gatewayStatement(["\\d .x", "f 1"], ["hdb"]), '.gw.syncexec["last value each (\\"system \\\\\\"d .x\\\\\\"\\";\\"f 1\\")";enlist `hdb]');
  // The call is still one string with its types, so it is read back.
  assert.deepStrictEqual(gatewayParts(gatewayStatement(["\\d .x", "f 1"], ["hdb"])), { query: 'last value each ("system \\"d .x\\"";"f 1")', types: ["hdb"] });
  // One statement, and statements that switch no context, go as they did.
  assert.strictEqual(joined(["\\d .x"]), 'system "d .x"');
  assert.strictEqual(joined(["a:1", "\\c 20 200", "a"]), 'a:1\n ;system "c 20 200"\n ;a');
});

test("functions defined after a \\d through a gateway are bound to its context, and call each other (#3057)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live, lines } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  await live.run("\\d .stats\nspread:{[b;a] a-b}\nmid:{[b;a] (b+a)%2}\nwide:{[b;a] spread[b;a]>mid[b;a]*0.01}\n\\d .");
  assert.strictEqual(live.history()[0].outcome, "ok");
  lines.length = 0;
  await live.run(".stats.wide[100;103]");
  assert.deepStrictEqual([live.history()[0].outcome, lines.slice(1)], ["ok", ["11b"]]);
  // The last statement's value is each server's answer, as of one string.
  lines.length = 0;
  await live.run("\\d .stats\nn:3 / wide enough\nwide[100;100+n]");
  assert.deepStrictEqual([live.history()[0].outcome, lines.slice(1)], ["ok", ["11b"]]);
  // A later query is in the root again.
  lines.length = 0;
  await live.run("string system \"d\"");
  assert.deepStrictEqual(lines.slice(1), ['".."']);
});

// One `.gw.` name anywhere made the whole selection the gateway's own, so
// a query under `n:count .gw.servers` ran on the gateway: 'trade (#3059).
test("a selection goes to a gateway statement by statement: its own as written, the rest through .gw.syncexec (#3059)", () => {
  const through = (code) => gatewayStatements(statements(code), ["rdb"]);
  assert.deepStrictEqual(through("n:count .gw.servers\nselect count i by sym from trade"), ["n:count .gw.servers", '.gw.syncexec["select count i by sym from trade";enlist `rdb]']);
  // Statements next to each other for the servers are one call.
  assert.deepStrictEqual(through("a:1\nb:a+1\n.gw.servers\ncount trade"), ['.gw.syncexec["a:1\\n ;b:a+1";enlist `rdb]', ".gw.servers", '.gw.syncexec["count trade";enlist `rdb]']);
  // A statement a name ties to one of the gateway's runs where it does:
  // what a call's answer was assigned to (#2361), what a call reads (#1951).
  let cut = statements('t:.gw.syncexec["select from trade";`rdb]\ncount t\nu:2#t\nmeta u');
  assert.strictEqual(gatewayStatements(cut, ["rdb"]), cut);
  cut = statements("t:`trade\n.gw.syncexec[({select from x};t);`rdb`hdb]");
  assert.strictEqual(gatewayStatements(cut, ["rdb"]), cut);
  assert.deepStrictEqual(through("t:.gw.servers\ncount trade\ncount t"), ["t:.gw.servers", '.gw.syncexec["count trade";enlist `rdb]', "count t"]);
  // A \d holds on both sides: for the gateway's statements where it is,
  // and at the head of each call after it.
  assert.deepStrictEqual(through("\\d .stats\nn:count .gw.servers\nf:{x+1}\n\\d .\ncount trade"), [
    "\\d .stats",
    "n:count .gw.servers",
    '.gw.syncexec["last value each (\\"system \\\\\\"d .stats\\\\\\"\\";\\"f:{x+1}\\")";enlist `rdb]',
    "\\d .",
    '.gw.syncexec["count trade";enlist `rdb]',
  ]);
  cut = statements("\\d .stats\ncount .gw.servers");
  assert.strictEqual(gatewayStatements(cut, ["rdb"]), cut);
  // None of the gateway's own: one call of all, as before.
  assert.deepStrictEqual(through("n:count trade / rows\nn*10"), ['.gw.syncexec["n:count trade / rows\\n ;n*10";enlist `rdb]']);
  assert.deepStrictEqual(through(""), []);
});

test("a query selected with one of the gateway's own statements still goes to its servers (#3059)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live, lines } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  lines.length = 0;
  await live.run("n:count .gw.servers\nexec sym from trade");
  assert.deepStrictEqual([live.history()[0].outcome, lines.slice(1)], ["ok", ["`a`b`c`d`e"]]);
  assert.strictEqual(live.history()[0].code, 'n:count .gw.servers\n.gw.syncexec["exec sym from trade";`rdb`hdb]');
  // Run again from the history, it goes as it was sent.
  await stub.commands.get("q-lint.rerunQuery")(live.history()[0]);
  assert.deepStrictEqual([live.history()[0].code, live.history()[0].outcome], ['n:count .gw.servers\n.gw.syncexec["exec sym from trade";`rdb`hdb]', "ok"]);
  // What reads a name the gateway's statement set stays with it.
  lines.length = 0;
  await live.run("n:count .gw.servers\nn+1");
  assert.deepStrictEqual([live.history()[0].code, live.history()[0].outcome, lines.slice(1)], ["n:count .gw.servers\nn+1", "ok", ["3"]]);
  // The servers' statement first, then the gateway's own count of them.
  lines.length = 0;
  await live.run("exec sym from trade\nn+count .gw.servers");
  assert.deepStrictEqual([live.history()[0].outcome, lines.slice(1)], ["ok", ["4"]]);
});

// The Process Explorer lists and reads the gateway's own tables, TorQ's
// root `logmsg` among them. Preview and the templates that run then went
// through .gw.syncexec: the grid showed a server's `logmsg` under the
// gateway's table, or failed for a table only the gateway has (#3061).
test("Preview and Table Templates of a table the Process Explorer lists on a gateway read the gateway's (#3061)", { skip }, async (t) => {
  const gw = await torq(t, "logmsg:([] msg:enlist `server)");
  const { live, lines } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  await live.run("logmsg:([] msg:`gw1`gw2)\nonlyhere:([] n:1 2 3)", undefined, []);
  const context = stub.newContext();
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  const { ProcessExplorer } = require("../out/explorerview.js");
  const { EXPLORER } = require("../out/explorer.js");
  const { SchemaTools } = require("../out/schemaview.js");
  const { SCHEMA_COMMANDS } = require("../out/schema.js");
  new ProcessExplorer(context, live);
  new SchemaTools(context, live);
  lines.length = 0;
  await stub.commands.get(EXPLORER.preview)({ kind: "table", name: "logmsg", partitioned: false });
  assert.deepStrictEqual([live.history()[0].code, live.history()[0].outcome], ["5 sublist logmsg", "ok"]);
  assert.match(lines.join("\n"), /gw1\ngw2/);
  await stub.commands.get(EXPLORER.preview)({ kind: "table", name: "onlyhere", partitioned: false });
  assert.deepStrictEqual([live.history()[0].code, live.history()[0].outcome], ["5 sublist onlyhere", "ok"]);
  lines.length = 0;
  stub.picks.push("Select first 100");
  await stub.commands.get(SCHEMA_COMMANDS.templates)({ kind: "table", label: "logmsg", name: "logmsg" });
  assert.deepStrictEqual([live.history()[0].code, live.history()[0].outcome], ["select[100] from logmsg", "ok"]);
  assert.match(lines.join("\n"), /gw1\ngw2/);
  // The same code from the editor is still a query for the servers.
  lines.length = 0;
  await live.run("select[100] from logmsg");
  assert.match(lines.join("\n"), /server/);
});

test("a drill-down, a wrangle or a cell edit from a gateway's result goes to the server types it came from (#2437)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  await live.runOnProcess("exec sym from trade where px>3", "gw", { serverTypes: ["hdb"] });
  assert.deepStrictEqual([live.history()[0].code, live.history()[0].outcome], ['.gw.syncexec["exec sym from trade where px>3";enlist `hdb]', "ok"]);
});

// The REPL, the Interactive Window and Smart Send (#2356), notebook cells
// and their Markdown live values (#2428) and the agent's tool (#2430) send
// code as Run does: through .gw.syncexec, as plain strings.
test("the REPL, a notebook cell, its live values and the agent's query go through the gateway as Run does (#2356, #2428, #2430)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  const { runText } = require("../out/consolerun.js");
  const ran = await runText(live, "count trade");
  assert.deepStrictEqual([ran.answer.ok, ran.answer.text], [true, ["2 3"]]);
  const { cellAnswer, liveValues } = require("../out/qnbrun.js");
  const via = (c) => live.gatewayed(c);
  const settings = { consoleSize: [25, 80], rows: 100, rowLimitFrom: "first" };
  const cell = await live.runOnActive("exec sym from trade", (c) => cellAnswer(c, { mode: "console" }, ["exec sym from trade"], settings, via));
  assert.strictEqual(cell.value[0], true, JSON.stringify(cell.value));
  assert.match(JSON.stringify(cell.value[1]), /`a`b`c`d`e/);
  const values = await live.runOnActive("count trade", (c) => liveValues(c, ["{{q: count trade}}"], via));
  assert.match(JSON.stringify(values.value), /2 3/);
  const { runAgentQuery } = require("../out/agent.js");
  const agent = await live.runOnActive("count trade", (c) => runAgentQuery(c, "count trade", [25, 80], via));
  assert.deepStrictEqual(agent.value.data, [[2], [3]]);
});

// A cell, Smart Send and the REPL's run from the editor read only the
// process's own server types: a file naming the HDB had its cells answered
// by the RDB, where Run Query on the same line asked the HDB (#3063).
test("a cell, Smart Send and the REPL send a file's code to the server types the file names (#3063)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  const vscode = require("vscode");
  const { runText } = require("../out/consolerun.js");
  const open = (name, text) => {
    const document = { uri: vscode.Uri.file(name), getText: () => text };
    vscode.workspace.textDocuments = [...vscode.workspace.textDocuments, document];
    return document.uri;
  };
  t.after(() => (vscode.workspace.textDocuments = []));
  const hist = open("/w/hist.q", "/ @servertypes hdb\n//// history\nexec sym from trade");
  let ran = await runText(live, "exec sym from trade", hist);
  assert.deepStrictEqual([ran.answer.ok, ran.answer.text], [true, ["`c`d`e"]]);
  // Several statements go as one query there.
  ran = await runText(live, "n:count trade\nn+1", hist);
  assert.deepStrictEqual([ran.answer.ok, ran.answer.text], [true, [",4"]]);
  // None: the gateway itself. A file naming none, and code from no file,
  // go to the process's own.
  ran = await runText(live, "role", open("/w/own.q", "/ @servertypes none\nrole"));
  assert.deepStrictEqual([ran.answer.ok, ran.answer.text], [true, ["`gateway"]]);
  for (const from of [open("/w/live.q", "exec sym from trade"), undefined]) {
    ran = await runText(live, "exec sym from trade", from);
    assert.deepStrictEqual([ran.answer.ok, ran.answer.text], [true, ["`a`b"]]);
  }
});

// What runs code inside a lambda of q-lint's cannot go through a deferred
// .gw.syncexec, and says so rather than run it on the gateway itself (#2357,
// #2432, #2434, #2435, #2589, #2590); Copy Value as JSON joins the servers'
// values on the gateway (#2433); SQL loads its engine on the servers (#2596).
test("on a TorQ gateway, features that need q-lint's lambda refuse, Copy Value as JSON and SQL go through it (#2357, #2432, #2433, #2434, #2435, #2589, #2590, #2596)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  const context = stub.newContext();
  const refusal = /^q-lint: (.+) runs the code in q-lint's own q, which on the TorQ gateway gw would run it on the gateway itself, not through \.gw\.syncexec on its servers as Run Query does\. Use Run Query there\.$/;
  const { registerBenchmark } = require("../out/benchmarkview.js");
  assert.match(await registerBenchmark(context, live).benchmark("count trade", "", "10 1"), refusal);
  const { registerAjExplainer } = require("../out/ajexplainview.js");
  assert.match(await registerAjExplainer(context, live).explainRow("aj[`sym`time;trade;quote]", "0"), refusal);
  const { registerJoinAssistant } = require("../out/joinassistview.js");
  assert.match(await registerJoinAssistant(context, live).assist("trade", "trade"), refusal);
  // The gateway's own code is no refusal, and Run's text for the rest.
  assert.strictEqual(live.gatewayRefusal("Benchmark", "count .gw.servers"), undefined);
  for (const feature of ["Time Lines on Process", "Record Query Snapshot", "Run Query Asynchronously"]) {
    assert.match(live.gatewayRefusal(feature, "count trade"), refusal);
  }
  const vscode = require("vscode");
  let clipboard = "";
  vscode.env = { clipboard: { readText: async () => clipboard, writeText: async (s) => void (clipboard = s) } };
  const { registerPaste } = require("../out/pasteview.js");
  registerPaste(context, live);
  stub.config.user["jsonConversion.enable"] = true;
  assert.strictEqual(await stub.commands.get("q-lint.copyAsJson")("exec sym from trade"), '["a","b","c","d","e"]');
  assert.strictEqual(live.goesThroughGateway('.s.e "select from trade"'), true);
  assert.strictEqual(live.goesThroughGateway(".gw.servers"), false);
});

// Copy Value as JSON read only the process's own server types: from a file
// naming others it copied another server's value than Run Query showed, and
// under `/ @servertypes none` asked the servers for the gateway's own (#3062).
test("Copy Value as JSON goes to the server types its file names, as Run Query does (#3062)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  const vscode = require("vscode");
  let clipboard = "";
  vscode.env = { clipboard: { readText: async () => clipboard, writeText: async (s) => void (clipboard = s) } };
  const context = stub.newContext();
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  require("../out/pasteview.js").registerPaste(context, live);
  stub.config.user["jsonConversion.enable"] = true;
  const copy = (text) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text: text.split("\n")[0] }), getText: () => text },
      selection: { active: { line: 0 }, isEmpty: true },
    };
    return stub.commands.get("q-lint.copyAsJson")();
  };
  assert.strictEqual(await copy("exec sym from trade"), '["a","b"]');
  assert.strictEqual(await copy("exec sym from trade\n/ @servertypes hdb"), '["c","d","e"]');
  assert.strictEqual(await copy("exec sym from trade\n/ @servertypes hdb rdb"), '["c","d","e","a","b"]');
  // None: the gateway's own value, which no server has.
  assert.strictEqual(await copy("role\n/ @servertypes none"), '"gateway"');
  // Code given without a file goes to the process's own.
  assert.strictEqual(await stub.commands.get("q-lint.copyAsJson")("exec sym from trade"), '["a","b"]');
});

// Run from Saved Queries, a query saved from a `/ @servertypes hdb` file
// went to the process's own server types, and so did its scheduled exports
// and dashboard tiles (#3064).
test("a saved query goes to the server types its own `/ @servertypes` line names, run or run apart (#3064)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live, lines } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb"] }]);
  assert.strictEqual(await live.connectTo("gw"), true);
  await live.runFilledIn("/ @servertypes hdb\nexec sym from trade", "history");
  assert.deepStrictEqual([live.history()[0].code, live.history()[0].outcome], ['.gw.syncexec["exec sym from trade";enlist `hdb]', "ok"]);
  assert.match(lines.join("\n"), /`c`d`e/);
  await live.runFilledIn("exec sym from trade", "live");
  assert.strictEqual(live.history()[0].code, '.gw.syncexec["exec sym from trade";enlist `rdb]');
  // A scheduled export and a dashboard tile run it apart.
  const apart = async (code, options) => (await live.runApart(live.processes()[0], code, undefined, options)).text.join("\n");
  assert.match(await apart("/ @servertypes hdb\ncount trade"), /^,?3$/);
  assert.match(await apart("count trade"), /^,?2$/);
  assert.match(await apart("/ @servertypes none\nrole"), /^`gateway$/);
  // Server types asked for outright still win.
  assert.match(await apart("/ @servertypes hdb\ncount trade", { serverTypes: ["rdb"] }), /^,?2$/);
});

test("a query run apart - a dashboard tile, a scheduled export, Query a Tag - goes through the gateway too (#1230)", { skip }, async (t) => {
  const gw = await torq(t);
  const { live } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] }]);
  const answer = await live.runApart(live.processes()[0], "count trade");
  assert.strictEqual(answer.ok, true, JSON.stringify(answer));
  // Each server's count, joined; the gateway has no trade of its own.
  assert.match(answer.text.join("\n"), /^(`s#)?2 3$/);
});

test("with q-lint.connection.torqGateway.enable off, a gateway's query goes as written and the commands refuse", { skip }, async (t) => {
  const gw = await torq(t);
  const { live, query } = await setUp(t, [{ label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb"] }]);
  stub.config.user["connection.torqGateway.enable"] = false;
  assert.strictEqual(await live.connectTo("gw"), true);
  const r = await query("exec sym from trade");
  // The gateway has no trade table of its own.
  assert.deepStrictEqual([r.code, r.outcome], ["exec sym from trade", "error"]);
  const before = live.history().length;
  stub.messages = [];
  await stub.commands.get(GATEWAY_COMMANDS.queryWith)("rdb");
  await stub.commands.get(GATEWAY_COMMANDS.set)("gw", "hdb");
  const off = "q-lint: TorQ gateways is turned off. Set q-lint.connection.torqGateway.enable to true to turn it on.";
  assert.deepStrictEqual(stub.messages, [["info", off], ["info", off]]);
  assert.strictEqual(live.history().length, before, "nothing was sent");
  assert.deepStrictEqual(live.processes()[0].gateway, ["rdb"]);
});

test("Set Gateway Server Types marks and unmarks a saved process", async (t) => {
  const { live } = await setUp(t, [{ label: "gw", host: "h", port: 1, tags: [] }]);
  stub.inputs.push((o) => (assert.strictEqual(o.validateInput("1x"), "Server types are q names: rdb hdb."), "rdb hdb"));
  await stub.commands.get(GATEWAY_COMMANDS.set)("gw");
  assert.deepStrictEqual(live.processes()[0].gateway, ["rdb", "hdb"]);
  await stub.commands.get(GATEWAY_COMMANDS.set)("gw", null);
  assert.strictEqual(live.processes()[0].gateway, undefined);
  // Querying with types needs a connected gateway.
  await stub.commands.get(GATEWAY_COMMANDS.queryWith)("rdb");
  assert.match(stub.messages.at(-1)[1], /not connected to a q process\. Set Gateway Server Types marks one\./);
});

test("a gateway call under a comment, or after another statement, is still one: it is not wrapped twice (#1951)", () => {
  assert.ok(isGatewayCall('/ all of today\n.gw.syncexec["select from trade";`rdb]'));
  assert.ok(isGatewayCall('/\na block\n\\\n\n  .gw.asyncexecjpt["q";`rdb;raze;();0D00:01] / the day'));
  assert.ok(isGatewayCall('t:`trade\n.gw.syncexec[({select from x};t);`rdb`hdb]'));
  assert.ok(isGatewayCall('\n\n.gw.syncexec["1";`rdb]'));
  // A comment or a string that names one is no call, and neither is one
  // inside another statement.
  assert.ok(!isGatewayCall('/ .gw.syncexec["1";`rdb]\nselect from trade'));
  assert.ok(!isGatewayCall('s:"\n .gw.syncexec[1]"'));
  assert.ok(!isGatewayCall("/ nothing to run"));
  assert.ok(!isGatewayCall(""));
});

test("Query Gateway with Server Types from a file bound to another process runs nothing there (#2370)", { skip }, async (t) => {
  const gw = await torq(t);
  const plain = await startQ(t, "trade:([] sym:enlist `p; px:enlist 9f)\n");
  const { live } = await setUp(t, [
    { label: "gw", host: "127.0.0.1", port: gw, tags: [], gateway: ["rdb", "hdb"] },
    { label: "plain", host: "127.0.0.1", port: plain, tags: [] },
  ]);
  assert.strictEqual(await live.connectTo("gw"), true);
  const vscode = require("vscode");
  vscode.window.activeTextEditor = {
    document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text: "count trade" }), getText: () => "count trade" },
    selection: { active: { line: 0 }, isEmpty: true },
  };
  // The stub's workspaceState keeps nothing: the binding, as it is kept.
  const bindings = { [vscode.Uri.file("/w/a.q").toString()]: "plain" };
  live.context.workspaceState.get = (key, fallback) => (key === "q-lint.fileConnections" ? bindings : fallback);
  assert.strictEqual(live.fileBinding(vscode.Uri.file("/w/a.q")), "plain");
  const before = live.history().length;
  stub.messages = [];
  await stub.commands.get(GATEWAY_COMMANDS.queryWith)("hdb");
  assert.strictEqual(live.history().length, before, "nothing was sent");
  assert.match(stub.messages.at(-1)[1], /this file's queries go to plain, not the gateway gw; nothing was run/);
});
