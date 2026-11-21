// The function profile's q against a real process (#987): PROFILE wraps
// each lambda of a namespace for one run, records every call by .z.p with its
// caller, and puts every original back - the same objects - whether the run
// succeeded or failed; PROFILE_CLEANUP leaves nothing of it behind, and puts
// the originals back itself when a run stopped half way. Needs a q binary,
// so it runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { PROFILE, PROFILE_CLEANUP, readProfile, functionStats, flame } = require("../out/profile.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-live-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source.replaceAll("$DIR", dir));
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true, cwd: dir });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      return {
        port,
        stop: () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        },
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(-child.pid, "SIGKILL");
  throw new Error(`q did not start listening: ${stderr}`);
}

async function connect(t, source) {
  const q = await startQ(source);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  return connection;
}

const SERVER = [
  "\\d .foo",
  "fib:{$[x<2;x;.foo.fib[x-1]+.foo.fib x-2]}",
  "nil:{[] 42}",
  "two:{[a;b] a+b}",
  "bad:{'\"boom\"}",
  "top:{[n] .foo.nil[]; .foo.two[n;1]; .foo.fib n}",
  "val:7",
  "proj:{x+y}[1]",
  "\\d .bar",
  "g:{x}",
  "\\d .",
  "keep:{(x;.foo.top;.foo.fib;.foo.nil;.foo.two;.foo.bad)}",
  "snap:keep[]",
  "",
].join("\n");

const same = async (c) => (await c.evaluate("snap~keep[]")).value === true;
const noState = async (c) => (await c.evaluate("not `prof in key `.qlint")).value === true;

test("every call is recorded with its caller, and every function is put back", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const profile = readProfile(await c.call(PROFILE, "`.foo", [".foo.top 10"]), ".foo");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "");
  assert.deepStrictEqual([...profile.functions].sort(), [".foo.bad", ".foo.fib", ".foo.nil", ".foo.top", ".foo.two"]);
  // top, nil, two, and fib 10's 177 calls.
  assert.strictEqual(profile.calls, 180);
  assert.strictEqual(profile.recorded.length, 180);
  const stats = Object.fromEntries(functionStats(profile).map((s) => [s.fn, s]));
  assert.strictEqual(stats[".foo.fib"].calls, 177);
  assert.strictEqual(stats[".foo.top"].calls, 1);
  // top holds every other call: its total is the longest, and its children
  // are nil, two and the outermost fib.
  const top = profile.recorded.find((r) => r.fn === ".foo.top");
  assert.deepStrictEqual(
    profile.recorded.filter((r) => r.parent === top.id).map((r) => r.fn).sort(),
    [".foo.fib", ".foo.nil", ".foo.two"],
  );
  assert.strictEqual(functionStats(profile)[0].fn, ".foo.top");
  assert.deepStrictEqual(flame(profile).filter((f) => f.depth === 1).map((f) => f.fn).sort(), [".foo.fib", ".foo.nil", ".foo.two"]);
  assert.ok(profile.overheadPerCall > 0 && profile.overheadPerCall < 1e6, String(profile.overheadPerCall));
  assert.ok(await same(c), "the functions are the ones that were there");
  assert.ok(await noState(c), ".qlint.prof is gone");
  // A projection stays as it was, and still works.
  assert.strictEqual(String((await c.evaluate(".foo.proj 2")).value), "3");
});

test("a run that fails stops there, and the functions are put back all the same", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const profile = readProfile(await c.call(PROFILE, "`.foo", [".foo.two[1;2]", ".foo.bad[]", ".foo.nil[]"]), ".foo");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "boom");
  assert.deepStrictEqual(profile.recorded.map((r) => r.fn), [".foo.two", ".foo.bad"]);
  assert.ok(await same(c));
  assert.ok(await noState(c));
});

test("a namespace that is not one is refused before anything changes", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  await assert.rejects(c.call(PROFILE, "`.nope", ["1+1"]), /not a namespace/);
  await c.call(PROFILE_CLEANUP, 0);
  assert.ok(await same(c));
  assert.ok(await noState(c));
  // One function, and a call to none of it: empty lists, read back.
  const one = readProfile(await c.call(PROFILE, "`.bar", ["1+1"]), ".bar");
  await c.call(PROFILE_CLEANUP, 0);
  assert.deepStrictEqual(one.functions, [".bar.g"]);
  assert.deepStrictEqual(one.recorded, []);
  const called = readProfile(await c.call(PROFILE, "`.bar", [".bar.g 1"]), ".bar");
  await c.call(PROFILE_CLEANUP, 0);
  assert.deepStrictEqual(called.recorded.map((r) => r.fn), [".bar.g"]);
});

test("the cleanup puts the originals back when a run stopped between", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  // As PROFILE leaves the process mid-run: a wrapper in place, the original kept.
  await c.evaluate(".qlint.prof.orig:(enlist `.foo.nil)!enlist .foo.nil; .foo.nil:{[] 0}");
  assert.strictEqual(await same(c), false);
  await c.call(PROFILE_CLEANUP, 0);
  assert.ok(await same(c));
  assert.ok(await noState(c));
});
