// The function profile's q against a real process (#987): PROFILE times
// each lambda of a namespace for one run, in its own text, records every
// call by .z.p with its caller, and puts every original back - the same
// objects - whether the run succeeded or failed; PROFILE_CLEANUP leaves nothing of it behind, and puts
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
const { PROFILE_CLEANUP, runProfile, readProfile, functionStats, flame } = require("../out/profile.js");

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

// The profile as the command runs it: the functions read, then sent back
// with the timing in their text.
const run = (c, ns, stmts) => runProfile((q, ...args) => c.call(q, ...args), ns, stmts);
const same = async (c) => (await c.evaluate("snap~keep[]")).value === true;
// Nothing of q-lint's is left: .qlint is not there, or - q cannot remove a
// context - is empty.
const noState = async (c) => (await c.evaluate("0=count key[`.qlint]except`")).value === true;

test("every call is recorded with its caller, and every function is put back", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const profile = readProfile(await run(c, ".foo", [".foo.top 10"]), ".foo");
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
  assert.deepStrictEqual(profile.kept, []);
  assert.ok(await same(c), "the functions are the ones that were there");
  assert.ok(await noState(c), ".qlint holds nothing");
  // A projection stays as it was, and still works.
  assert.strictEqual(String((await c.evaluate(".foo.proj 2")).value), "3");
});

test("a run that fails stops there, and the functions are put back all the same", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const profile = readProfile(await run(c, ".foo", [".foo.two[1;2]", ".foo.bad[]", ".foo.nil[]"]), ".foo");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "boom");
  assert.deepStrictEqual(profile.recorded.map((r) => r.fn), [".foo.two", ".foo.bad"]);
  assert.ok(await same(c));
  assert.ok(await noState(c));
});

test("a namespace that is not one is refused before anything changes", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  await assert.rejects(run(c, ".nope", ["1+1"]), /not a namespace/);
  await c.call(PROFILE_CLEANUP, 0);
  assert.ok(await same(c));
  assert.ok(await noState(c));
  // One function, and a call to none of it: empty lists, read back.
  const one = readProfile(await run(c, ".bar", ["1+1"]), ".bar");
  await c.call(PROFILE_CLEANUP, 0);
  assert.deepStrictEqual(one.functions, [".bar.g"]);
  assert.deepStrictEqual(one.recorded, []);
  const called = readProfile(await run(c, ".bar", [".bar.g 1"]), ".bar");
  await c.call(PROFILE_CLEANUP, 0);
  assert.deepStrictEqual(called.recorded.map((r) => r.fn), [".bar.g"]);
});

test("the cleanup puts the originals back when a run stopped between", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  // As PROFILE leaves the process mid-run: a timed text in place, the original kept.
  await c.evaluate(".qlint.prof.saved:(enlist `.foo.nil)!enlist .foo.nil; .foo.nil:{[] 0}; .qlint.prof.inst:(enlist `.foo.nil)!enlist .foo.nil");
  assert.strictEqual(await same(c), false);
  await c.call(PROFILE_CLEANUP, 0);
  assert.ok(await same(c));
  assert.ok(await noState(c));
});

test("a definition the profiled code made itself is kept, the others put back (#1271)", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const profile = readProfile(await run(c, ".foo", [".foo.nil:{[] 43}", ".foo.top 3"]), ".foo");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "");
  // And it is answered as kept: the panel said every function was put back (#2980).
  assert.deepStrictEqual(profile.kept, [".foo.nil"]);
  assert.strictEqual(String((await c.evaluate(".foo.nil[]")).value), "43");
  assert.strictEqual((await c.evaluate("(.foo.top;.foo.fib;.foo.two;.foo.bad)~snap 1 2 4 5")).value, true);
  // Nor does the cleanup of a stopped run undo one.
  await c.evaluate(".qlint.prof.saved:(enlist `.foo.nil)!enlist {[] 1}; .qlint.prof.inst:(enlist `.foo.nil)!enlist {[] 0}");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(String((await c.evaluate(".foo.nil[]")).value), "43");
  assert.ok(await noState(c));
});

test("a name longer than the process's \\c is still the function timed (#1869)", { skip }, async (t) => {
  // -3! of the name, cut at 40 characters, named a function that is not there.
  const c = await connect(t, "\\c 25 40\n.app.f:{[x] x+1}\n.app.computeTheVeryLongFunctionNameForPricing:{[x] .app.side::1+.app.f x; .app.side}\n.app.side:0\n");
  const long = ".app.computeTheVeryLongFunctionNameForPricing";
  const profile = readProfile(await run(c, ".app", [`${long} 1`]), ".app");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "");
  assert.deepStrictEqual(profile.recorded.map((r) => r.fn).sort(), [long, ".app.f"]);
  // The original ran: its side effect is there.
  assert.strictEqual(String((await c.evaluate(".app.side")).value), "3");
  assert.deepStrictEqual(Array.from((await c.evaluate("system\"c\"")).value, Number), [25, 40]);
});

test("a reference the run took to a timed function keeps answering once the profile is over (#2973)", { skip }, async (t) => {
  // A callback registered by the code profiled: it held a wrapper, which
  // called .qlint.prof.call - gone with the profile.
  const c = await connect(t, ".ns.tick:{[x] x+1}\n.ns.run:{[] `cb set .ns.tick; .z.ts:.ns.tick; cb 1}\n");
  const profile = readProfile(await run(c, ".ns", [".ns.run[]"]), ".ns");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "");
  assert.deepStrictEqual(profile.recorded.map((r) => r.fn), [".ns.run", ".ns.tick"]);
  assert.ok(await noState(c));
  assert.strictEqual(String((await c.evaluate("cb 1")).value), "2");
  assert.strictEqual(String((await c.evaluate(".z.ts 41")).value), "42");
  // And the name holds the function it held.
  assert.strictEqual((await c.evaluate("last value .ns.tick")).value, "{[x] x+1}");
});

test("a function that calls itself through .z.s is counted call by call (#2977)", { skip }, async (t) => {
  // The wrapper called the original, whose .z.s was the original: one call.
  const c = await connect(t, ".ns.fact:{$[x<2;1;x*.z.s x-1]}\n");
  const profile = readProfile(await run(c, ".ns", ["r:.ns.fact 5"]), ".ns");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "");
  assert.strictEqual(String((await c.evaluate("r")).value), "120");
  assert.strictEqual(profile.calls, 5);
  assert.deepStrictEqual(profile.recorded.map((r) => [r.id, r.parent]), [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4]]);
  assert.deepStrictEqual(functionStats(profile).map((s) => [s.fn, s.calls]), [[".ns.fact", 5]]);
});

test("the profile adds no depth to a recursion: one 1500 deep still runs (#2978)", { skip }, async (t) => {
  // A wrapper, .qlint.prof.call and its trap were three frames a call: q's
  // stack, good for 1999, gave out near 700.
  const c = await connect(t, ".ns.r:{$[x=0;0;1+.ns.r x-1]}\n");
  assert.strictEqual(String((await c.evaluate(".ns.r 1500")).value), "1500");
  const profile = readProfile(await run(c, ".ns", ["d:.ns.r 1500"]), ".ns");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "");
  assert.strictEqual(String((await c.evaluate("d")).value), "1500");
  assert.strictEqual(profile.calls, 1501);
  assert.strictEqual(flame(profile).at(-1).depth, 1500);
});

test("a call an error ended is closed when its caller returns, and a function whose text takes no timing is left untimed", { skip }, async (t) => {
  const c = await connect(
    t,
    [
      ".ns.bad:{[x] x+`a}",
      ".ns.sig:{[x] if[x>0; '\"no\"]; x}",
      ".ns.ok:{[x] :x*2}",
      ".ns.top:{[x] a:@[.ns.bad;x;{0}]; b:@[.ns.sig;x;{0}]; a+b+.ns.ok x}",
      // A lambda written in k: its text is not `{` to `}`.
      ".ns.k:value \"k){x+1}\"",
      "",
    ].join("\n"),
  );
  const profile = readProfile(await run(c, ".ns", ["v:.ns.top 3"]), ".ns");
  await c.call(PROFILE_CLEANUP, 0);
  assert.strictEqual(profile.error, "");
  assert.strictEqual(String((await c.evaluate("v")).value), "6");
  const calls = Object.fromEntries(profile.recorded.map((r) => [r.fn, r]));
  assert.deepStrictEqual(profile.recorded.map((r) => r.fn), [".ns.top", ".ns.bad", ".ns.sig", ".ns.ok"]);
  // The signal the text writes is seen, and closes its call there; the
  // error q signalled is not, and that call ends with its caller.
  assert.strictEqual(calls[".ns.sig"].start + calls[".ns.sig"].duration <= calls[".ns.ok"].start, true);
  assert.strictEqual(calls[".ns.bad"].start + calls[".ns.bad"].duration, calls[".ns.top"].start + calls[".ns.top"].duration);
  assert.deepStrictEqual(profile.untimed, [".ns.k"]);
  assert.deepStrictEqual([...profile.functions].sort(), [".ns.bad", ".ns.ok", ".ns.sig", ".ns.top"]);
  assert.strictEqual(String((await c.evaluate(".ns.k 1")).value), "2");
});
