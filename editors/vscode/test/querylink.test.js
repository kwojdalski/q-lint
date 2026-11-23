// Shareable query links (#1038): links made and read back, Copy Query Link
// and opening a link through the stand-in `vscode` module - shown, bound,
// asked before running, nothing run when declined - on and off, and when
// QLINT_TEST_Q names a q, a link run on its process and a write in a link
// to a guarded process held by the guard.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { Live } = require("../out/live.js");
const { ADMIN_COMMANDS, adminOff, readAdmin } = require("../out/admin.js");
const { LINK_MAX, queryLink, readQueryLink } = require("../out/querylink.js");
const { QueryLinks } = require("../out/querylinkview.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A link as VS Code hands it to the handler: path, and query decoded.
const asUri = (link) => {
  const url = new URL(link);
  return { path: url.pathname, query: decodeURIComponent(url.search.slice(1)) };
};

test("a link holds the query and the label, whatever characters they have, and reads back", () => {
  const code = "select from t where a&b, c like \"x%\"\n/ 100% {{date}} + 1";
  const made = queryLink("vscode", "wojdalski.q-lint", "desk/rdb & co", code);
  assert.match(made.link, /^vscode:\/\/wojdalski\.q-lint\/query\?process=[A-Za-z0-9_-]+&code=[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(readQueryLink(asUri(made.link).path, asUri(made.link).query), { code, process: "desk/rdb & co" });
  assert.deepStrictEqual(readQueryLink("/query", "code=" + Buffer.from("1+1").toString("base64url")), { code: "1+1" });
  assert.deepStrictEqual(readQueryLink("/other", ""), { problem: "q-lint opens no link to /other" });
  assert.deepStrictEqual(readQueryLink("/query", "process=YQ"), { problem: "the link holds no query" });
  assert.deepStrictEqual(readQueryLink("/query", "code=a b"), { problem: "the link is not encoded as q-lint encodes one" });
  assert.deepStrictEqual(queryLink("vscode", "x.y", "a", "  "), { problem: "there is no query to link to" });
  assert.match(queryLink("vscode", "x.y", "a", "x".repeat(LINK_MAX)).problem, /over 8000/);
});

test("the switch: on by default, contributed, its command hidden while off; links activate the extension", () => {
  assert.strictEqual(readAdmin((_k, f) => f).queryLinks, true);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  assert.strictEqual(section.properties["q-lint.query.links.enable"].default, true);
  assert.ok(pkg.contributes.commands.some((c) => c.command === ADMIN_COMMANDS.copyLink && c.category === "q-lint"));
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === ADMIN_COMMANDS.copyLink);
  assert.strictEqual(menus.length, 2);
  for (const m of menus) assert.match(m.when, /config\.q-lint\.query\.links\.enable/);
  assert.ok(pkg.activationEvents.includes("onUri"));
});

async function setUp(t, processes, text = "1+1") {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const handlers = [];
  vscode.window.registerUriHandler = (handler) => {
    const entry = { handler, disposed: false, dispose() { this.disposed = true; } };
    handlers.push(entry);
    return entry;
  };
  const clipboard = [];
  vscode.env = { uriScheme: "vscode", clipboard: { writeText: async (s) => clipboard.push(s) } };
  const opened = [];
  let n = 0;
  vscode.workspace.openTextDocument = async (options) => {
    const name = `Untitled-${++n}`;
    const document = { uri: { scheme: "untitled", fsPath: name, toString: () => `untitled:${name}` }, languageId: options.language, lineAt: () => ({ text: options.content }), getText: () => options.content };
    opened.push(options);
    return document;
  };
  vscode.window.showTextDocument = async (document) => {
    vscode.window.activeTextEditor = { document, selection: { active: { line: 0 }, isEmpty: true } };
    return vscode.window.activeTextEditor;
  };
  const live = new Live(context);
  const links = new QueryLinks(context, live);
  vscode.window.activeTextEditor = {
    document: { uri: { scheme: "file", fsPath: "/a.q", toString: () => "file:///a.q" }, languageId: "q", lineAt: () => ({ text }), getText: () => text },
    selection: { active: { line: 0 }, isEmpty: true },
  };
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, links, handlers, clipboard, opened };
}

test("Copy Query Link copies a link to the statement, aimed at a picked process", async (t) => {
  const { clipboard } = await setUp(t, [{ label: "rdb", host: "h", port: 1, tags: [] }], "select from t where x={{v}}");
  stub.picks.push("rdb");
  const link = await stub.commands.get(ADMIN_COMMANDS.copyLink)();
  assert.deepStrictEqual(clipboard, [link]);
  assert.deepStrictEqual(readQueryLink(asUri(link).path, asUri(link).query), { code: "select from t where x={{v}}", process: "rdb" });
});

test("opening a link shows the query bound to the process and runs nothing when declined", async (t) => {
  const { live, links, handlers, opened } = await setUp(t, [{ label: "rdb", host: "h", port: 1, tags: [] }]);
  assert.strictEqual(handlers.length, 1);
  let ran = 0;
  live.queryCode = async () => void ran++;
  const link = queryLink("vscode", "wojdalski.q-lint", "rdb", "count t").link;
  stub.picks.push(undefined);
  assert.strictEqual(await links.open(asUri(link)), false);
  assert.deepStrictEqual(opened, [{ language: "q", content: "count t" }]);
  assert.strictEqual(live.fileBinding(vscode.window.activeTextEditor.document.uri), "rdb");
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && text === "A link asks to run this query on rdb. Run it?"));
  assert.strictEqual(ran, 0);
  // A process not in the list: open, not bound, not asked, not run.
  const other = queryLink("vscode", "wojdalski.q-lint", "elsewhere", "count t").link;
  assert.strictEqual(await links.open(asUri(other)), false);
  assert.match(stub.messages.at(-1)[1], /not in your Processes list/);
  assert.strictEqual(ran, 0);
  // Said yes: run.
  stub.picks.push("Run");
  assert.strictEqual(await handlers[0].handler.handleUri(asUri(link)), undefined);
  await sleep(10);
  assert.strictEqual(ran, 1);
});

test("a link run with {{placeholders}} asks for them and sends the query filled in (#1225)", async (t) => {
  const { live, links } = await setUp(t, [{ label: "rdb", host: "h", port: 1, tags: [] }]);
  const sent = [];
  live.queryCode = async (code) => void sent.push(code);
  stub.picks.push("Run");
  stub.inputs.push("`AAPL");
  assert.strictEqual(await links.open(asUri(queryLink("vscode", "wojdalski.q-lint", "rdb", "select from t where sym={{s}}").link)), true);
  assert.deepStrictEqual(sent, ["select from t where sym=`AAPL"]);
  // Escape at the placeholder sends nothing.
  stub.picks.push("Run");
  stub.inputs.push(undefined);
  await links.open(asUri(queryLink("vscode", "wojdalski.q-lint", "rdb", "select from t where sym={{s}}").link));
  assert.deepStrictEqual(sent, ["select from t where sym=`AAPL"]);
});

// Copy offers discovered processes, but open accepted saved labels only:
// a link to desk/rdb was refused even on the machine that made it.
test("a link to a discovered process opens bound to it (#1125)", async (t) => {
  const { live, links } = await setUp(t, []);
  live.discovery.discovered = () => [{ server: { label: "desk", url: "http://x/" }, state: { processes: [{ label: "rdb", host: "h", port: 1, tags: [] }], problems: [], loading: false } }];
  live.queryCode = async () => {};
  stub.picks.push(undefined);
  assert.strictEqual(await links.open(asUri(queryLink("vscode", "wojdalski.q-lint", "desk/rdb", "count t").link)), false);
  assert.strictEqual(live.fileBinding(vscode.window.activeTextEditor.document.uri), "desk/rdb");
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && text === "A link asks to run this query on desk/rdb. Run it?"));
});

test("turned off, the handler is disposed, links are not opened and the command refuses; on again without a reload", async (t) => {
  const { links, handlers, opened } = await setUp(t, [{ label: "rdb", host: "h", port: 1, tags: [] }]);
  stub.config.user["query.links.enable"] = false;
  stub.changeConfig("q-lint.query.links.enable");
  assert.strictEqual(handlers[0].disposed, true);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.copyLink)(), undefined);
  assert.strictEqual(await links.open(asUri(queryLink("vscode", "wojdalski.q-lint", "rdb", "1").link)), false);
  assert.deepStrictEqual(stub.messages, [["info", adminOff("queryLinks")], ["info", adminOff("queryLinks")]]);
  assert.strictEqual(opened.length, 0);
  stub.config.user["query.links.enable"] = true;
  stub.changeConfig("q-lint.query.links.enable");
  assert.strictEqual(handlers.length, 2);
  assert.strictEqual(handlers[1].disposed, false);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-link-"));
  fs.writeFileSync(path.join(dir, "server.q"), `me:\`${port}\n`);
  const child = spawn(`${Q} ${path.join(dir, "server.q")} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) return { stop };
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

test("a link run goes to its process; a write in a link to a guarded process is held (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, links } = await setUp(t, [
    { label: "a", host: "127.0.0.1", port, tags: [] },
    { label: "p", host: "127.0.0.1", port, tags: ["prod"] },
  ]);
  stub.picks.push("Run");
  assert.strictEqual(await links.open(asUri(queryLink("vscode", "wojdalski.q-lint", "a", "me").link)), true);
  assert.deepStrictEqual(live.history().map((e) => [e.process, e.code, e.outcome]), [["a", "me", "ok"]]);
  // Run said to the link, then the guard asks, and is declined.
  stub.picks.push("Run", undefined);
  await links.open(asUri(queryLink("vscode", "wojdalski.q-lint", "p", "x:1").link));
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /would change p/.test(text)), JSON.stringify(stub.messages));
  assert.strictEqual(live.history().length, 1);
});
