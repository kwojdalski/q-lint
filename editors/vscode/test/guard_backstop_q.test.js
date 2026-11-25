// The read-only guard's backstop over real IPC: code the guard reads as
// read-only goes to a guarded process under `reval` (query.ts `trapLines`),
// so a write the guard misses is refused by q, not made. Every bypass form
// of the guard's fourth hunt (#2264-#2276) and the fuzz's writer families,
// sent under `reval` as if the guard had missed it, leaves a sandbox q as it
// was; reads still run, `\d` holds across statements, a refused read is told
// apart from any other error, and a process without `reval` is sent the
// plain lambda. Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const { refusedByReval, NO_REVAL } = require("../out/query.js");
const { writes } = require("../out/guard.js");
const generator = require("./guard_fuzz_gen.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 200];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INIT = fs.readFileSync(path.join(__dirname, "guard_fuzz_init.q"), "utf8");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// A sandbox q (guard_fuzz_init.q) in a directory of its own, with `extra`
/// run after the init, and a connection to it.
class Sandbox {
  constructor(extra = "") {
    this.extra = extra;
  }
  async start() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-backstop-"));
    fs.writeFileSync(path.join(this.dir, "init.q"), `${INIT}\n${this.extra}\n.hz.base:.hz.snap[];\n`);
    this.port = await freePort();
    this.child = spawn(Q, ["init.q", "-p", `127.0.0.1:${this.port}`, "-q"], { cwd: this.dir, stdio: ["ignore", "ignore", "ignore"] });
    this.dead = false;
    this.child.on("exit", () => {
      this.dead = true;
    });
    for (let i = 0; i < 200; i++) {
      await sleep(30);
      this.connection = await QConnection.open({ host: "127.0.0.1", port: this.port }, 1000).catch(() => undefined);
      if (this.connection !== undefined) return;
    }
    throw new Error("q did not start listening");
  }
  async stop() {
    await this.connection?.close();
    if (this.child !== undefined && !this.dead) {
      const exited = new Promise((r) => this.child.once("exit", r));
      this.child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
  /// `code` sent as a query under `reval`, as `Live` sends what the guard
  /// reads as read-only to a guarded process: the answer, and what changed
  /// ("" for nothing). Started again after a change, or a closed connection.
  async run(code) {
    const c = this.connection;
    c.readOnly = true;
    c.refused = undefined;
    let answer;
    try {
      answer = await Promise.race([c.query(statements(code), SIZE), sleep(5000).then(() => ({ ok: false, error: "<hang>" }))]);
    } catch (error) {
      answer = { ok: false, error: `<${error.message}>` };
    }
    c.readOnly = false;
    let diff;
    if (!c.isOpen || answer.error === "<hang>") {
      diff = "<closed>";
    } else {
      await c.evaluate("::");
      const check = await c.evaluate(".hz.check[]").catch((e) => ({ value: `<check failed: ${e.message}>` }));
      diff = String(check.value).split(" ").filter((x) => x !== "" && !x.startsWith(".s.") && x !== ".Q.a0").join(" ");
    }
    if (diff !== "") {
      await this.stop();
      await this.start();
    }
    return { answer, diff, refused: c.refused };
  }
}

/// The bypasses of the guard's fourth hunt, each as the hunt sent it.
const BYPASSES = [
  // #2264 assignment written as a call
  ":[a;77]", "(:)[a;77]", "::[a;77]", "+:[a;1]", ",:[b;7]", "-:[a;1]", ":[b 0;77]", ":[d`a;77]", ":[.ns.v;77]", ":[.z.ts;{}]",
  ":[(a;s);(1;2)]", "count t;:[a;77]", "$[1b;:[a;77];0]", "k):[a;77]",
  // #2265, #2266 eval of a tree
  "eval((:);`a;77)", "eval(+;0;(:;`a;77))", "eval(enlist;(:;`a;77))", "eval(count;(:;`a;77))", "-6!(+;0;(:;`a;77))",
  "((eval))(:;`a;77)", "(eval')enlist(:;`a;77)", "eval/[(:;`a;77)]", "'[eval;::](:;`a;77)", "(eval/)(:;`a;77)", "(-6!)(:;`a;77)",
  "((-6!))(:;`a;77)", "((eval))(?;enlist`sym;enlist`zz)",
  // #2267 picked from a list or dictionary, passed through {x}
  "{x}[@][`b;0;:;77]", "(@;.)[0][`b;0;:;77]", "(.;::)[0][`b;enlist 0;:;77]", "(`a`b!(@;.))[`a][`b;0;:;77]", "(?;::)[0][`sym;`zz]",
  "{[f]f}[?][`sym;`zz]", "{x}[!][-11;`:tp.log]", "(eval;::)[0](:;`a;77)", "({.[x;();:;77]};{x})[0]`a", "(`w`r!({.[x;();:;77]};{x}))[`w]`a",
  // #2268 an evaluator given to a function that applies it
  "@[{'x};\"a:77\";value]", "@[{'x};\"a:77\";get]", "@[{'x};\"a:77\";.h.val]", "@[{'x};\"a:77\";(value;::)0]", "@[{'x};\"a:77\";{value x}]",
  "@[{'x};`:o.txt;hopen]", ".Q.fs[value each;`:f.q]", ".Q.fs[{value each x};`:f.q]", ".Q.fsn[value each;`:f.q;100]", "@[;\"a:77\"] value",
  // #2269 a by-name target computed
  "@[{x}`b;0;:;77]", "update a:77 from {x}`t", "`a xdesc {x}`t", "xdesc[`a]{x}`t", "?[{x}`sym;`zz]", "{x}[`sym]?`zz",
  "![{x}`t;();0b;(enlist`a)!enlist 77]", ".[{x}`b;enlist 0;:;77]", "@[{y}[0;`b];0;:;77]", "@[.[{x};enlist`b];0;:;77]", "@[enlist[`b]0;0;:;77]",
  "update a:77 from enlist[`t]0", "@[;0;:;77]{x}`b", "{.[x;();:;77]}{x}`a",
  // #2270 an amend projection composed
  "'[@[;0;:;77];::]`b", "('[@[;0;:;77];{x}])`b", "(@[;0;:;77]first@)`b", "(@[;0;:;77]{x}@)`b", "(@[;0;:;77]) @/: enlist`b",
  // #2271 a writing lambda applied infix with an iterator
  "`b{@[x;0;:;y]}'77", "`a{.[x;();:;y]}/:77 78", "`a{.[x;();:;y]}\\:77", "`b{@[x;0;:;y]}/77", "`b{@[x;0;:;y]}\\77", "`a`c{.[x;();:;y]}'77 78",
  // #2272 a writer picked out of .h
  ".h[`ht]`g", "(.h`ht)`g", "(.h@`ht)`g", "(get`.h)[`ht]`g", ".h[`$\"ht\"]`g", "{.h[x]}[`ht]`g",
  // #2273 .h.val
  ".h.val\"a:77\"", ".h[`val]\"a:77\"", "{x}[.h.val]\"a:77\"",
  // #2274 a string evaluated whole
  "value\"\\n/\\na:77\"", "value\"count t\\n/\\na:77\"", "value\"count t\\n\\\\\\na:77\"", "get\"count t\\n/\\na:77\"", "eval parse\"count t\\n/\\na:77\"",
  "0\"count t\\n/\\na:77\"", "neg[0]\"count t\\n/\\na:77\"", "@[value;\"count t\\n/\\na:77\";::]", "value/[\"count t\\n/\\na:77\"]", "{value x}\"count t\\n/\\na:77\"",
  // #2275 k's monadic < ~ >
  "k)~`:g.txt", "k)<`:o.txt", "k)(~)`:g.txt", "k)~:`:g.txt", "k){~x}`:g.txt", "k)~-1!`g.txt", "k)<`$\":o.txt\"", "k){<x}`:o.txt",
  // what q refuses under reval, by kind
  "a:77", "`a set 77", "@[`b;0;:;77]", "update a:9 from `t", "`sym?`zz", "`:o.txt 0: enlist\"x\"", "hopen `:o.txt", "hdel `:g.txt",
  "system \"echo x > o2.txt\"", ".z.ts:{}", "value \"a:77\"", "eval (:;`a;77)", "\\t 100", "-11!`:tp.log", "{a::5}[]", "`t upsert (4;`w)",
  "`:o2 set t", "save `:t", "\\l f.q", "\\cd db", "\\c 10 10", "`ZZ setenv \"1\"", "0\"a:1\"",
];

test("every bypass form of the guard's fourth hunt, sent under reval, leaves the process unchanged", { skip, timeout: 300_000 }, async (t) => {
  const box = new Sandbox();
  t.after(() => box.stop());
  await box.start();
  const changed = [];
  let missed = 0;
  for (const code of BYPASSES) {
    if (writes(code).length === 0) missed++;
    const { diff } = await box.run(code);
    if (diff !== "") changed.push({ code, diff });
  }
  t.diagnostic(`${BYPASSES.length} forms, ${missed} of them read as read-only by the guard now`);
  assert.deepStrictEqual(changed, []);
});

test("reval does not stop a breakpoint patching a function in place, so the guard must ask about it (#2276)", { skip, timeout: 60_000 }, async (t) => {
  const box = new Sandbox("g:{a:x+1;a*2};");
  t.after(() => box.stop());
  await box.start();
  for (const code of [".Q.bs[g;1]", ".Q.bs[upd;1]", ".Q.bc[g;1;::]", ".Q.Ls(g;enlist 1;enlist 0xff)", "-104!(g;enlist 1;enlist 0xff)", "(.Q`bs)[g;1]"]) {
    assert.notDeepStrictEqual(writes(code), [], code);
  }
  // q refuses the update of .Q.BP, but g's code is patched before it: g
  // then gives a wrong answer, or with no console takes q down.
  assert.deepStrictEqual((await box.run("g 1")).answer.text, ["4"]);
  const { refused } = await box.run(".Q.bs[g;1]");
  assert.match(refused, /^noupdate/);
  assert.notDeepStrictEqual((await box.run("g 1")).answer.text, ["4"]);
});

test("the fuzz's writer families, sent under reval whatever the guard reads, change nothing", { skip, timeout: 600_000 }, async (t) => {
  generator.setSeed(Number(process.env.QLINT_GUARD_FUZZ_SEED ?? 1));
  const count = Number(process.env.QLINT_BACKSTOP_FUZZ ?? 1500);
  const box = new Sandbox();
  t.after(() => box.stop());
  await box.start();
  const seen = new Set();
  const changed = [];
  for (let n = 0; n < count; n++) {
    const x = generator.gen();
    if (seen.has(x.e) || x.fam === "read") continue;
    seen.add(x.e);
    const { diff } = await box.run(x.e);
    if (diff !== "") changed.push({ e: x.e, fam: x.fam, diff });
  }
  t.diagnostic(`${seen.size} distinct writes sent under reval`);
  assert.deepStrictEqual(changed, []);
});

test("reads run under reval as under value; a refusal is told apart from another error", { skip, timeout: 60_000 }, async (t) => {
  const box = new Sandbox("trade:([] sym:`a`b`a; price:1 2 3f); cache:{if[not `c in key `.;c::x]; x}; .ns.g:{x+`a};");
  t.after(() => box.stop());
  await box.start();
  const reads = [
    "select from trade", "select sum price by sym from trade", "exec price from trade where sym=`a", "update p2:2*price from trade",
    "delete from trade where sym=`b", "`price xdesc trade", "trade lj `sym xkey select sym, n:1 from trade", "?[trade;();0b;()]",
    "![trade;();0b;(enlist`price)!enlist(*;`price;2)]", "@[t;`a;neg]", "meta trade", "tables[]", "key`.", "system\"d\"", "\\c", "\\d",
    "\\t count trade", "{x+1} each til 3", "{a:1;a+x}[2]", ".Q.s trade", "-1 \"x\";", "0N!count trade", "value\"count t\"", "get`trade",
    "parse\"a:1\"", ".ns.v", ".j.j t", "`trade", "`a`b!1 2", "`p`q?`q", "k)#t", "{x} peach 1 2 3", ".Q.w[]", ".Q.gc[]", "\\w", "\\P",
  ];
  for (const code of reads) {
    const { answer, diff } = await box.run(code);
    assert.ok(answer.ok, `${code}: ${answer.error}`);
    assert.strictEqual(diff, "", code);
  }
  // \d in one statement holds for the next, and is gone after the query, as under value.
  assert.deepStrictEqual((await box.run("\\d .ns\nv")).answer.text, ["42"]);
  assert.deepStrictEqual((await box.run("system \"d\"")).answer.text, ["`."]);
  // A read that writes on the way, or that runs a shell, is refused - and said to be.
  for (const [code, error] of [["cache 5", /^noupdate/], ["system \"pwd\"", /^sys$/], ["\\cd", /^sys$/], ["a:1;count t", /^noupdate/]]) {
    const { answer, refused, diff } = await box.run(code);
    assert.ok(!answer.ok && error.test(answer.error), `${code}: ${JSON.stringify(answer)}`);
    assert.strictEqual(refused, answer.error, code);
    assert.ok(refusedByReval(answer.error));
    assert.strictEqual(diff, "", code);
  }
  // Any other error is not a refusal; its trace starts at the user's code.
  const { answer, refused } = await box.run(".ns.g 1");
  assert.strictEqual(answer.error, "type");
  assert.strictEqual(refused, undefined);
  assert.ok(!/reval/.test(answer.trace), answer.trace);
  assert.match(answer.trace, /\.ns\.g/);
});

test("a process without reval is sent the plain lambda, and the connection says so", { skip, timeout: 60_000 }, async (t) => {
  const box = new Sandbox(".q:(enlist`reval)_ .q;");
  t.after(() => box.stop());
  await box.start();
  const c = box.connection;
  c.readOnly = true;
  const answer = await c.query(statements("count t"), SIZE);
  assert.deepStrictEqual(answer, { ok: true, type: -7, text: ["3"] });
  assert.strictEqual(c.noReval, true);
  assert.notStrictEqual(answer.error, NO_REVAL);
  // Nothing protects it then but the guard: the plain lambda assigns.
  c.readOnly = true;
  await c.query(statements("zz2:1i"), SIZE);
  c.readOnly = false;
  assert.strictEqual((await c.evaluate("zz2")).value, 1);
});
