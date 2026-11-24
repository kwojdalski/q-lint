// The process list as data (#901): hosts, labels and the passwords tied to
// them. Run after `tsc`; nothing here needs an editor or a q process.
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { address, consoleSize, hostProblem, parseProcesses } = require("../out/processes.js");
const { readLive } = require("../out/liveconfig.js");

// An IPv6 address was written `::1:5000`: the port read as part of the
// address, in the row, its tooltip, the status bar and the connect error.
test("a host and port are written as a URL writes them, an IPv6 host in brackets", () => {
  assert.strictEqual(address("localhost", 5000), "localhost:5000");
  assert.strictEqual(address("10.0.0.1", 5000), "10.0.0.1:5000");
  assert.strictEqual(address("::1", 5000), "[::1]:5000");
  assert.strictEqual(address("fe80::1%en0", 5000), "[fe80::1%en0]:5000");
});

// A host typed as a URL writes it, `[::1]`, was kept as typed, and node
// looked that up as a name: the process never connected (ENOTFOUND).
test("an IPv6 host in brackets is kept without them, so it connects", async (t) => {
  const { processes } = parseProcesses([{ label: "a", host: " [::1] ", port: 5000 }]);
  assert.strictEqual(processes[0].host, "::1");
  const server = net.createServer((s) => s.end()).listen(0, "::1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  }).catch(() => t.skip("no IPv6 loopback"));
  t.after(() => server.close());
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    const s = net.connect({ host: processes[0].host, port: server.address().port }, () => {
      s.end();
      resolve();
    });
    s.on("error", reject);
  });
});

// The host box took anything not blank: `localhost:5000` or `host 2` was
// looked up as a name, and failed only on connect.
test("a host is refused when it holds a port, a space or a slash", () => {
  assert.strictEqual(hostProblem("localhost"), undefined);
  assert.strictEqual(hostProblem("[::1]"), undefined);
  assert.strictEqual(hostProblem("::1"), undefined);
  assert.strictEqual(hostProblem(" "), "A host is needed.");
  assert.strictEqual(hostProblem("localhost:5000"), "A host only: the port is asked for next.");
  assert.strictEqual(hostProblem("a b"), "A host has no spaces or slashes.");
  assert.strictEqual(hostProblem("tcp://h"), "A host only: the port is asked for next.");
});

// Two or more colons were taken as an IPv6 address unchecked: `[::1]:5000`
// and `host:5000:rdb` were accepted, then dialled as a name.
test("a host with colons is accepted only when it is an IPv6 address", () => {
  assert.strictEqual(hostProblem("fe80::1"), undefined);
  assert.strictEqual(hostProblem("[::1]:5000"), "A host only: the port is asked for next.");
  assert.strictEqual(hostProblem("rdb-host:5000:rdb"), "A host only: the port is asked for next.");
});

// A discovery server, an import or the shared list was never checked for a
// host the Add box would refuse: it was listed, then failed at connect.
test("a listed process with a host the Add box would refuse is skipped", () => {
  const read = parseProcesses([
    { label: "a", host: "rdb-host:5000", port: 5000 },
    { label: "b", host: "h b", port: 1 },
    { label: "c", host: "::1", port: 1 },
  ]);
  assert.deepStrictEqual(read.processes.map((p) => p.label), ["c"]);
  assert.deepStrictEqual(read.problems, [
    "Entry 1 (a): A host only: the port is asked for next.",
    "Entry 2 (b): A host has no spaces or slashes.",
  ]);
});

// Tooltips are Markdown: a label, host, user or tag was read as Markdown,
// so `*prod*` showed as italic prod, `a_b_c` lost its underscores and a user
// with a backtick broke out of its code span.
test("a process's tooltip shows its label, host, user and tags as written", () => {
  const { processTooltip, markdownText } = require("../out/processes.js");
  assert.strictEqual(markdownText("*prod* a_b [x](command:y) <b>"), "\\*prod\\* a\\_b \\[x\\]\\(command:y\\) \\<b\\>");
  const tip = processTooltip({ label: "*eu*_rdb", host: "h_1", port: 5000, user: "a`b", tags: ["x_y"] });
  assert.strictEqual(tip, "**\\*eu\\*\\_rdb**\n\nh\\_1:5000\n\nuser a\\`b\n\ntags: x\\_y");
  assert.strictEqual(
    processTooltip({ label: "r", host: "::1", port: 1, tags: [], tls: true }, "desk_1"),
    "**r**\n\n\\[::1\\]:1 (TLS)\n\nno user\n\nno tags\n\nlisted by desk\\_1, connected to as desk\\_1/r",
  );
});

// A saved process may be labelled `desk/rdb`, as a discovered one is named
// once qualified. Both kept their password under that label, and Connect
// took the discovered one for the saved one: the saved process's password
// went to the host the discovery server named.
test("a saved and a discovered process of one label keep their passwords apart", () => {
  const { passwordKey } = require("../out/processes.js");
  const { findDiscovered, EMPTY_STATE } = require("../out/discovery.js");
  const discovered = [{ server: { label: "desk", url: "https://x/" }, state: { ...EMPTY_STATE, processes: [{ label: "rdb", host: "evil", port: 1, tags: [] }] } }];
  const found = findDiscovered(discovered, "desk/rdb");
  assert.deepStrictEqual(found, { label: "desk/rdb", host: "evil", port: 1, tags: [], server: "desk" });
  assert.strictEqual(passwordKey({ label: "desk/rdb" }), "q-lint.password.desk/rdb");
  assert.notStrictEqual(passwordKey(found), passwordKey({ label: "desk/rdb" }));
  // A saved list never holds the server: it is not read back.
  assert.strictEqual(parseProcesses([{ label: "a", host: "h", port: 1, server: "desk" }]).processes[0].server, undefined);
});

// An import replaces a process of the same label. The password stored for
// the old one stayed, and was sent to whatever host and user the file named.
test("an import that moves a process to another host or user forgets its password", () => {
  const { passwordsToForget } = require("../out/processes.js");
  const p = (label, host, user, port = 5000) => ({ label, host, port, tags: [], ...(user ? { user } : {}) });
  const saved = [p("a", "h1", "u"), p("b", "h1", "u"), p("c", "h1", "u"), p("d", "h1", "u"), p("e", "h1", "u")];
  const incoming = [p("a", "h1", "u"), p("b", "evil", "u"), p("c", "h1", "v"), p("d", "h1", "u", 6000), p("new", "h", "u")];
  assert.deepStrictEqual(passwordsToForget(saved, incoming), ["b", "c", "d"]);
  // Reached another way - TLS or a tunnel on or off - is another host too (#1269).
  const reached = [p("t", "h1", "u"), p("s", "h1", "u"), p("x", "h1", "u")].map((q, i) => (i === 0 ? { ...q, tls: true } : i === 1 ? { ...q, ssh: "jump" } : q));
  assert.deepStrictEqual(passwordsToForget(reached, [p("t", "h1", "u"), p("s", "h1", "u"), { ...p("x", "h1", "u"), ssh: "other" }]), ["t", "s", "x"]);
  assert.deepStrictEqual(passwordsToForget(reached, reached), []);
});

test("an import that takes away TLS, a tunnel or a guarded tag says what (#1269)", () => {
  const { protectionsRemoved, withProtections } = require("../out/processes.js");
  const guard = ["prod", "prd", "production"];
  const before = [
    { label: "a", host: "h", port: 1, tags: ["Prod", "eu"], tls: true, ssh: "jump" },
    { label: "b", host: "h", port: 2, tags: ["dev"] },
  ];
  const incoming = [
    { label: "a", host: "h", port: 1, tags: ["eu"] },
    { label: "b", host: "h", port: 2, tags: [] },
    { label: "n", host: "h", port: 3, tags: [] },
  ];
  assert.deepStrictEqual(protectionsRemoved(before, incoming, guard), [{ label: "a", what: ["TLS", "SSH tunnel", "tag Prod"] }]);
  assert.deepStrictEqual(withProtections(incoming[0], before[0], guard), { label: "a", host: "h", port: 1, tags: ["eu", "Prod"], tls: true, ssh: "jump" });
  assert.deepStrictEqual(protectionsRemoved(before, before, guard), []);
});

test("a console size of the wrong type, as settings.json allows, is no size instead of failing every query", () => {
  assert.strictEqual(consoleSize(null), undefined);
  assert.strictEqual(consoleSize(50), undefined);
  assert.strictEqual(consoleSize([50, 160]), undefined);
  assert.deepStrictEqual(readLive((key, fallback) => (key === "output.consoleSize" ? 50 : fallback)).consoleSize, [50, 160]);
});
