// The process list as data (#901): hosts, labels and the passwords tied to
// them. Run after `tsc`; nothing here needs an editor or a q process.
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { address, hostProblem, parseProcesses } = require("../out/processes.js");

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
