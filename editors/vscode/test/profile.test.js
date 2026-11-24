// The function profile (#987): the namespace checked, the process's answer
// read, the table and the flame chart worked out - and, through the stand-in
// `vscode` and a q process played by a socket server, the command's life:
// off, it refuses and sends nothing; on, it sends the profile and then the
// cleanup; and the read-only guard asks first on a guarded process whatever
// the query, since the run replaces its functions. The q side is
// profile_q.test.js.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { PROFILE, PROFILE_CLEANUP, namespaceProblem, readProfile, functionStats, flame, profileView } = require("../out/profile.js");
const { registerFunctionProfile, PROFILE_FUNCTIONS, namespaceIn, guardedCode } = require("../out/profileview.js");
const { guardCheck } = require("../out/guard.js");
const { Live } = require("../out/live.js");
const pkg = require("../package.json");

// top(1) calls a(2) and b(3); a calls a(4), recursively; b calls a(5).
const RAW = [
  10000,
  1700,
  "",
  5,
  [".ns.top", ".ns.a", ".ns.b"],
  [1, 2, 3, 4, 5],
  [0, 1, 1, 2, 3],
  [".ns.top", ".ns.a", ".ns.b", ".ns.a", ".ns.a"],
  [0, 100, 600, 200, 700],
  [1000, 400, 300, 100, 200],
];

test("a namespace is a top-level dotted name, and not q's own", () => {
  assert.strictEqual(namespaceProblem(".lib"), undefined);
  assert.strictEqual(namespaceProblem(" .lib "), undefined);
  assert.match(namespaceProblem("lib"), /a dot and a name/);
  assert.match(namespaceProblem(".lib.sub"), /a dot and a name/);
  assert.match(namespaceProblem("."), /a dot and a name/);
  assert.match(namespaceProblem(".q"), /q's or q-lint's own/);
  assert.match(namespaceProblem(".z"), /own/);
  assert.match(namespaceProblem(".qlint"), /own/);
  assert.strictEqual(namespaceIn("r:.z.p; .lib.run[1] + .other.f 2"), ".lib");
  assert.strictEqual(namespaceIn("`.lib.x"), undefined);
  assert.strictEqual(namespaceIn("1+1"), undefined);
});

test("the answer is read, and one function or one call reads as atoms", () => {
  const p = readProfile(RAW, ".ns");
  assert.strictEqual(p.calls, 5);
  assert.deepStrictEqual(p.recorded[3], { id: 4, parent: 2, fn: ".ns.a", start: 200, duration: 100 });
  const one = readProfile([5, 1, "", 1, ".ns.g", 1, 0, ".ns.g", 3, 4], ".ns");
  assert.deepStrictEqual(one.functions, [".ns.g"]);
  assert.deepStrictEqual(one.recorded, [{ id: 1, parent: 0, fn: ".ns.g", start: 3, duration: 4 }]);
  const none = readProfile([5, 1, "", 0, [], [], [], [], [], []], ".ns");
  assert.deepStrictEqual(none.recorded, []);
  assert.throws(() => readProfile("junk", ".ns"), /something other than a profile/);
  assert.throws(() => readProfile([1, 1, "", 1, [], [1, 2], [0], [], [], []], ".ns"), /profile/);
});

test("the table counts a recursive call once in the total, and self time without the calls made", () => {
  const stats = Object.fromEntries(functionStats(readProfile(RAW, ".ns")).map((s) => [s.fn, s]));
  assert.deepStrictEqual(stats[".ns.top"], { fn: ".ns.top", calls: 1, total: 1000, self: 300, mean: 1000, max: 1000 });
  // a: 400 (with its inner call inside) + 200 under b; self 300 + 100 + 200.
  assert.deepStrictEqual(stats[".ns.a"], { fn: ".ns.a", calls: 3, total: 600, self: 600, mean: 200, max: 400 });
  assert.deepStrictEqual(stats[".ns.b"], { fn: ".ns.b", calls: 1, total: 300, self: 100, mean: 300, max: 300 });
  assert.deepStrictEqual(functionStats(readProfile(RAW, ".ns")).map((s) => s.fn), [".ns.top", ".ns.a", ".ns.b"]);
});

test("the flame chart merges calls by their path of callers, widest first", () => {
  assert.deepStrictEqual(flame(readProfile(RAW, ".ns")), [
    { fn: ".ns.top", duration: 1000, calls: 1, depth: 0, offset: 0 },
    { fn: ".ns.a", duration: 400, calls: 1, depth: 1, offset: 0 },
    { fn: ".ns.a", duration: 100, calls: 1, depth: 2, offset: 0 },
    { fn: ".ns.b", duration: 300, calls: 1, depth: 1, offset: 400 },
    { fn: ".ns.a", duration: 200, calls: 1, depth: 2, offset: 400 },
  ]);
  const view = profileView(readProfile(RAW, ".ns"), "dev", ".ns.top[]");
  assert.strictEqual(view.overheadTotal, 1700 * 5);
  assert.strictEqual(view.functions, 3);
});

test("the guard reads every run as a write to the namespace", () => {
  const prod = { label: "p", tags: ["prod"] };
  const settings = { enabled: true, tags: ["prod"] };
  assert.strictEqual(guardCheck("count trade", [prod], settings), undefined);
  assert.notStrictEqual(guardCheck(guardedCode(".ns", "count trade"), [prod], settings), undefined);
  // Code that ends the script or opens a comment does not hide it (#1441),
  // and what the code itself writes is still read.
  for (const code of ["f 1\n\\", "f 1\n/", "f 1\n\\\na:1"]) {
    assert.notStrictEqual(guardCheck(guardedCode(".ns", code), [prod], settings), undefined, code);
  }
  assert.ok(guardCheck(guardedCode(".ns", "a:1"), [prod], settings).reasons.includes("assigns a"));
});

test("the switch is declared on, and the command only where it can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.query.functionProfile.enable"].default, true);
  const command = pkg.contributes.commands.find((c) => c.command === PROFILE_FUNCTIONS);
  assert.strictEqual(command.title, "Profile Functions on Process");
  const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === PROFILE_FUNCTIONS);
  assert.match(palette.when, /config\.q-lint\.query\.functionProfile\.enable/);
});

/// A q process played by a socket server, answering every message with
/// `answer`; the messages are kept, decoded.
async function fakeQ(answer) {
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        sent.push(deserialize(message));
        const out = serialize(answer);
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    sent,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

function fakePanels() {
  const panels = [];
  vscode.window.createWebviewPanel = (id, title) => {
    const panel = {
      id,
      title,
      disposed: false,
      posted: [],
      listeners: [],
      webview: {
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (u) => u,
        postMessage: async (m) => void panel.posted.push(m),
        onDidReceiveMessage: (l) => void panel.listeners.push(l),
      },
      onDidDispose: () => {},
      reveal: () => {},
      dispose() {
        this.disposed = true;
      },
    };
    panels.push(panel);
    return panel;
  };
  return panels;
}

async function setUp(t, tags, config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const q = await fakeQ(RAW);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags }]);
  const live = new Live(context);
  const profile = registerFunctionProfile(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  return { q, live, profile };
}

test("off, the command refuses and sends nothing; on, the profile runs, is cleaned up after and is shown", async (t) => {
  const panels = fakePanels();
  const { q, live, profile } = await setUp(t, [], { "query.functionProfile.enable": false });
  await live.connectTo("rdb");
  const before = q.sent.length;
  assert.match(await stub.commands.get(PROFILE_FUNCTIONS)(".ns", ".ns.top[]"), /The function profile is turned off\. Set q-lint\.query\.functionProfile\.enable to true/);
  assert.strictEqual(q.sent.length, before);
  assert.strictEqual(panels.length, 0);

  stub.config.user["query.functionProfile.enable"] = true;
  stub.changeConfig("q-lint.query.functionProfile.enable");
  const view = await stub.commands.get(PROFILE_FUNCTIONS)(".ns", ".ns.top[]");
  assert.deepStrictEqual(q.sent.slice(before), [
    [PROFILE, ".ns", [".ns.top[]"]],
    [PROFILE_CLEANUP, 0],
  ]);
  assert.strictEqual(view.stats.length, 3);
  assert.strictEqual(panels.length, 1);
  assert.match(panels[0].title, /profile of \.ns on rdb/);
  // The page asks once ready; every name goes as data.
  panels[0].listeners.forEach((l) => l({ type: "ready" }));
  assert.strictEqual(panels[0].posted.at(-1).type, "profile");
  assert.match(panels[0].webview.html, /Content-Security-Policy/);
  assert.doesNotMatch(panels[0].webview.html, /\.ns\.top/);
  // A namespace that cannot be one is refused before anything is sent.
  const sent = q.sent.length;
  assert.match(await stub.commands.get(PROFILE_FUNCTIONS)(".q", "1+1"), /own/);
  assert.strictEqual(q.sent.length, sent);
  // Off again: the panel closes, nothing more is sent.
  stub.config.user["query.functionProfile.enable"] = false;
  stub.changeConfig("q-lint.query.functionProfile.enable");
  assert.strictEqual(panels[0].disposed, true);
  assert.strictEqual(profile.panelOpen(), false);
  await stub.commands.get(PROFILE_FUNCTIONS)(".ns", ".ns.top[]");
  assert.strictEqual(q.sent.length, sent);
});

test("on a guarded process the run is held until confirmed, even for a query that only reads", async (t) => {
  fakePanels();
  const { q, live } = await setUp(t, ["prod"]);
  await live.connectTo("rdb");
  const before = q.sent.length;
  stub.picks.push(undefined);
  assert.match(await stub.commands.get(PROFILE_FUNCTIONS)(".ns", "count trade"), /not confirmed/);
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /would change rdb/.test(text)));
  assert.strictEqual(q.sent.length, before);
  stub.picks.push("Run Anyway");
  await stub.commands.get(PROFILE_FUNCTIONS)(".ns", "count trade");
  assert.deepStrictEqual(q.sent.slice(before).map((m) => m[0]), [PROFILE, PROFILE_CLEANUP]);
});

test("the profile table's sort headers are buttons with aria-sort, and keep the focus as they sort (#1252)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const { Element } = require("./pagedom.js");
  Element.prototype.appendChild = function (n) {
    this.append(n);
    return n;
  };
  const body = new Element("body");
  // `textContent = ""` empties the page, as a browser's does.
  Object.defineProperty(body, "textContent", { set: () => (body.children = []), get: () => "" });
  const listeners = [];
  const posted = [];
  const sandbox = {
    document: {
      body,
      createElement: (t) => new Element(t),
      querySelector: (sel) => body.all((e) => e.tagName === "BUTTON" && sel.includes(`"${e.getAttribute("data-key")}"`))[0] ?? null,
    },
    window: { addEventListener: (_t, f) => listeners.push(f) },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "media", "profile.js"), "utf8"), sandbox);
  const stat = (fn, calls) => ({ fn, calls, total: calls, self: calls, mean: 1, max: 1 });
  const data = { type: "profile", id: 1, code: "f[]", process: "dev", namespace: ".ns", functions: 2, calls: 3, recorded: 3, total: 3, overheadPerCall: 1, overheadTotal: 3, stats: [stat(".ns.a", 1), stat(".ns.b", 2)], frames: [] };
  listeners.forEach((f) => f({ data }));
  const ths = () => body.all((e) => e.tagName === "TH");
  assert.deepStrictEqual(ths().map((th) => th.getAttribute("aria-sort")), ["none", "none", "descending", "none", "none", "none"]);
  const calls = ths()[1].children[0];
  assert.strictEqual(calls.tagName, "BUTTON");
  calls.fire("click");
  assert.strictEqual(ths()[1].getAttribute("aria-sort"), "descending");
  assert.strictEqual(Element.focused.getAttribute("data-key"), "calls");
  assert.notStrictEqual(Element.focused, calls);
  assert.strictEqual(posted.at(-1).rendered.sortedBy, "calls desc");
  delete Element.prototype.appendChild;
});
