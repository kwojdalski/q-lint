// The read-only guard (#918) against a real q, differentially: random
// expressions (guard_fuzz_gen.js) that the guard reads as read-only are run
// on a sandbox q, and none may change it - a global, a namespace, a system
// setting, the environment, a handle or a file in its directory. Three
// rounds of bypasses found this way were fixed by class (#2186-#2211), and
// a fifth hunt's families (#2264-#2277) joined the generator; this keeps
// them fixed. Needs a q
// binary, so it runs only when QLINT_TEST_Q names one, as guard_q.test.js
// does. QLINT_GUARD_FUZZ sets how many expressions (default 5000) and
// QLINT_GUARD_FUZZ_SEED the seed (default 1).
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writes } = require("../out/guard.js");
const { statements } = require("../out/statements.js");
const generator = require("./guard_fuzz_gen.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const COUNT = Number(process.env.QLINT_GUARD_FUZZ ?? 5000);
const SEED = Number(process.env.QLINT_GUARD_FUZZ_SEED ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// The sandbox's state, and how to compare it (guard_fuzz_init.q): every
/// global of every namespace but `.hz`'s own hashed, the system settings,
/// and each file under its directory hashed. `.hz.run` runs a query's
/// statements trapped, each with `value`, as the extension's `RUN` does.
const INIT = fs.readFileSync(path.join(__dirname, "guard_fuzz_init.q"), "utf8");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// A char vector, serialized.
function qString(text) {
  const str = Buffer.from(text, "utf8");
  const head = Buffer.from([10, 0, 0, 0, 0, 0]);
  head.writeInt32LE(str.length, 2);
  return Buffer.concat([head, str]);
}

/// A q message: `.hz.run` applied to `text` cut into its statements, as a
/// query sends them, or `text` alone, as a string.
function message(text, run) {
  const sym = Buffer.from(".hz.run\0", "latin1");
  let body;
  if (run) {
    const cut = statements(text);
    const list = Buffer.from([0, 0, 0, 0, 0, 0]);
    list.writeInt32LE(cut.length, 2);
    body = Buffer.concat([Buffer.from([0, 0, 2, 0, 0, 0, 0xf5]), sym, list, ...cut.map(qString)]);
  } else {
    body = qString(text);
  }
  const head = Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]);
  head.writeInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

/// The string or error a response holds.
function answer(buf) {
  const type = buf.readInt8(8);
  if (type === 10) return { ok: true, text: buf.subarray(14, 14 + buf.readInt32LE(10)).toString("utf8") };
  if (type === -128) return { ok: false, text: buf.subarray(9, buf.indexOf(0, 9)).toString("utf8") };
  return { ok: true, text: `<type ${type}>` };
}

/// A sandbox q in a directory of its own, started again after each run
/// that changed it.
class Sandbox {
  constructor() {
    this.child = undefined;
    this.socket = undefined;
  }
  async start() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-guard-fuzz-"));
    fs.writeFileSync(path.join(this.dir, "init.q"), INIT);
    this.port = await freePort();
    this.child = spawn(Q, ["init.q", "-p", `127.0.0.1:${this.port}`, "-q"], { cwd: this.dir, stdio: ["ignore", "ignore", "ignore"] });
    this.dead = false;
    this.child.on("exit", () => {
      this.dead = true;
    });
    for (let i = 0; i < 200; i++) {
      await sleep(30);
      if (await this.connect().then(() => true, () => false)) return;
    }
    throw new Error("q did not start listening");
  }
  connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, "127.0.0.1");
      s.once("error", reject);
      s.once("connect", () => s.write(Buffer.from("fz\x03\x00", "latin1")));
      s.once("data", () => {
        s.removeAllListeners("error");
        this.socket = s;
        this.buffer = Buffer.alloc(0);
        this.pending = undefined;
        s.on("data", (x) => {
          this.buffer = Buffer.concat([this.buffer, x]);
          if (this.buffer.length >= 8 && this.buffer.length >= this.buffer.readInt32LE(4)) {
            const m = this.buffer.subarray(0, this.buffer.readInt32LE(4));
            this.buffer = this.buffer.subarray(m.length);
            const p = this.pending;
            this.pending = undefined;
            p?.(answer(m));
          }
        });
        s.on("error", () => {});
        s.on("close", () => {
          this.socket = undefined;
          const p = this.pending;
          this.pending = undefined;
          p?.({ ok: false, text: "<closed>" });
        });
        resolve();
      });
    });
  }
  request(buf, ms) {
    if (this.socket === undefined) return Promise.resolve({ ok: false, text: "<closed>" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        resolve({ ok: false, text: "<hang>" });
      }, ms);
      this.pending = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.socket.write(buf);
    });
  }
  async stop() {
    this.socket?.destroy();
    this.socket = undefined;
    if (this.child !== undefined && !this.dead) {
      const exited = new Promise((r) => this.child.once("exit", r));
      this.child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
  /// What running `code` changed, "" for nothing; started again after a change.
  async run(code) {
    await this.request(message(code, true), 5000);
    let check = await this.request(message(".hz.check[]", false), 20000);
    if (check.ok && check.text === "") {
      // Once more, for a change a timer or a deferred callback makes.
      await this.request(message("::", false), 5000);
      check = await this.request(message(".hz.check[]", false), 20000);
    }
    const diff = !check.ok ? `<check failed: ${check.text}>` : check.text.split(" ").filter((x) => x !== "" && !x.startsWith(".s.") && x !== ".Q.a0").join(" ");
    if (diff !== "") {
      await this.stop();
      await this.start();
    }
    return diff;
  }
}

test("no expression the guard reads as read-only changes a sandbox q", { skip, timeout: Math.max(120_000, COUNT * 40) }, async (t) => {
  generator.setSeed(SEED);
  const boxes = [new Sandbox(), new Sandbox()];
  t.after(() => Promise.all(boxes.map((b) => b.stop())));
  await Promise.all(boxes.map((b) => b.start()));
  const queue = [];
  const seen = new Set();
  let asked = 0;
  for (let n = 0; n < COUNT; n++) {
    const x = generator.gen();
    if (seen.has(x.e)) continue;
    seen.add(x.e);
    if (writes(x.e).length > 0) asked++;
    else queue.push(x);
  }
  const bypasses = [];
  let next = 0;
  await Promise.all(
    boxes.map(async (box) => {
      while (next < queue.length) {
        const x = queue[next++];
        if ((await box.run(x.e)) === "") continue;
        // Again in a fresh sandbox, so a change left by an earlier run, or
        // noise, is not taken for this one's.
        const diff = await box.run(x.e);
        if (diff !== "") bypasses.push({ e: x.e, fam: x.fam, diff });
      }
    }),
  );
  t.diagnostic(`${seen.size} distinct expressions: ${asked} asked about, ${queue.length} read as read-only and run, ${bypasses.length} changed q`);
  assert.deepStrictEqual(bypasses, []);
});
