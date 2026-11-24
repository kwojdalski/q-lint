// What Start Process and the Tickerplant Log start ends with the extension
// host, even when it is killed and nothing is disposed (#1676).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a child with a lifeline ends when its parent is killed", { skip: process.platform === "win32" ? "no process groups" : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-lifeline-"));
  // The host: starts a long-running child in a group of its own, as the
  // launcher does, gives it a lifeline, and says its pid.
  fs.writeFileSync(
    path.join(dir, "host.js"),
    `const { spawn } = require("child_process");
const { lifeline } = require(${JSON.stringify(path.join(__dirname, "..", "out", "lifeline.js"))});
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
lifeline(child);
console.log(child.pid);
setInterval(() => {}, 1000);`,
  );
  const host = spawn(process.execPath, [path.join(dir, "host.js")], { stdio: ["ignore", "pipe", "inherit"] });
  const pid = await new Promise((resolve) => host.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  assert.ok(alive(pid));
  host.kill("SIGKILL");
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
  const left = alive(pid);
  if (left) process.kill(pid, "SIGKILL");
  assert.strictEqual(left, false, "the child outlived its killed parent");
});

test("no lifeline on Windows, nor for a child that never started", () => {
  const { lifeline } = require("../out/lifeline.js");
  assert.strictEqual(lifeline({ pid: 1 }, "win32"), undefined);
  assert.strictEqual(lifeline({ pid: undefined }, "linux"), undefined);
});

test("on Windows a group's signal ends the child's whole tree with taskkill, q.exe under q.cmd's cmd.exe too (#1745)", () => {
  const { signalGroup } = require("../out/lifeline.js");
  const ran = [];
  const killed = [];
  const run = (command, args) => {
    ran.push([command, ...args]);
    return { once: () => {} };
  };
  signalGroup({ pid: 42, kill: (s) => killed.push(s) }, "SIGTERM", "win32", run);
  assert.deepStrictEqual(ran, [["taskkill", "/T", "/F", "/PID", "42"]]);
  assert.deepStrictEqual(killed, []);
  // No taskkill to run: the child alone.
  signalGroup({ pid: 42, kill: (s) => killed.push(s) }, "SIGKILL", "win32", () => { throw new Error("ENOENT"); });
  assert.deepStrictEqual(killed, ["SIGKILL"]);
});
