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
const { GATEWAY_COMMANDS, fileServerTypes, gatewayStatement, isGatewayCall, joined, readGateway, symbols } = require("../out/gateway.js");
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
  assert.strictEqual(joined(["\\d .x", "f:{x+\n 1}", "f 1"]), 'system "d .x"\n ;f:{x+\n 1}\n ;f 1');
  assert.ok(isGatewayCall('.gw.syncexec["1";`rdb]'));
  assert.ok(!isGatewayCall("select from trade"));
  // TorQ's typed and timed variants are gateway calls too (#1427).
  assert.ok(isGatewayCall('.gw.syncexecj["q";`rdb;raze]'));
  assert.ok(isGatewayCall('.gw.asyncexecjpt["q";`rdb;raze;();0D00:01]'));
  assert.ok(!isGatewayCall(".gw.syncexec_x[1]"));
});

test("a file names its server types on a `/ @servertypes` line", () => {
  assert.deepStrictEqual(fileServerTypes("/ @servertypes rdb hdb\nselect from t"), ["rdb", "hdb"]);
  assert.deepStrictEqual(fileServerTypes("a:1\n/@servertypes `hdb,rdb\n"), ["hdb", "rdb"]);
  assert.strictEqual(fileServerTypes("  / @servertypes rdb\n"), undefined);
  assert.strictEqual(fileServerTypes("/ @servertypes 1x\n"), undefined);
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
      ".gw.run:{[query;servertypes] servertypes,:(); if[count m:servertypes except key .gw.h; '\"not all of the requested server types are available: \",\",\" sv string m]; raze .gw.h[servertypes]@\\:({$[`.pm.valp~key`.pm.valp;.pm.valp x;value x]};query)}",
      ".gw.replies:()",
      ".gw.syncexec:{[query;servertypes] -30!(::); .gw.replies,:enlist (.z.w;@[{(0b;.gw.run . x)};(query;servertypes);{(1b;x)}]); }",
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
  assert.ok(!isGatewayCall('r:.gw.syncexec["1";`rdb]'));
  assert.ok(!isGatewayCall("/ nothing to run"));
  assert.ok(!isGatewayCall(""));
});
