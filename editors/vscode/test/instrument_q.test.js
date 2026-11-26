// Instrumenting a process's functions against a real q (#979, #985): the
// coverage probes count, the locals are kept, and every definition is put
// back as it was, in its own context, with `.qlint` empty. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { connect, skip } = require("./qserver.js");
const { definitions, DRIFT, readDrift } = require("../out/definitions.js");
const { coverageText, localsText, installLambda, restoreExpression, readInstalled, readRestored } = require("../out/instrument.js");
const { RUN, readAnswer } = require("../out/query.js");

const LIB = [
  "/ a library",
  "f:{[a;b]",
  "  c:a+b;",
  "  $[c>10;big c;small c]}",
  "big:{x*2}",
  "small:{[x] y:x+1;",
  "  y}",
  "\\d .ns",
  "h:{[p] k p}",
  "k:{p:x; p+1}",
  "\\d .",
  "",
].join("\n");

const value = async (c, text) => (await c.evaluate(text)).value;

test("coverage counts each statement, and the functions are put back as they were", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "\\l lib.q\n.qlint.cache.p1:42\n", { "lib.q": LIB });
  const defs = definitions(fs.readFileSync(path.join(dir, "lib.q"), "utf8"));
  assert.deepStrictEqual(defs.map((d) => d.name), ["f", "big", "small", ".ns.h", ".ns.k"]);
  const before = await value(c, "{.Q.s1 (value each x),'(get each x)~'get each x}`f`big`small`.ns.h`.ns.k");
  const states = readDrift(await c.call(DRIFT, defs.map((d) => d.name).join(" ")));
  let next = 0;
  const covered = defs.map((d) => {
    const cov = coverageText(d.text, next);
    next += cov.statements.length;
    return cov;
  });
  const statuses = readInstalled(
    await c.call(installLambda("cov"), defs.map((d) => d.name), defs.map((d) => states.get(d.name).text), covered.map((x) => x.text), next),
    defs.length,
  );
  assert.deepStrictEqual(statuses, ["ok", "ok", "ok", "ok", "ok"]);
  // The functions run as before, in their own context.
  assert.strictEqual(Number(await value(c, "f[1;2]")), 4);
  assert.strictEqual(Number(await value(c, ".ns.h 5")), 6);
  // Redefined meanwhile: left as it is, and named.
  await value(c, "big:{x*3}");
  const restored = readRestored(await c.call(restoreExpression("cov")));
  assert.deepStrictEqual(restored.kept, ["big"]);
  // f: 2 statements once, big never, small 2 once, .ns.h once, .ns.k 2 once.
  assert.deepStrictEqual(restored.d.map(Number), [1, 1, 0, 1, 1, 1, 1, 1]);
  await value(c, "big:{x*2}");
  const after = await value(c, "{.Q.s1 (value each x),'(get each x)~'get each x}`f`big`small`.ns.h`.ns.k");
  assert.strictEqual(after, before);
  assert.strictEqual(await value(c, "(`cov in key`.qlint;.qlint.cache.p1)~(0b;42)"), true);
  // With nothing else of q-lint's there .qlint is left empty - q cannot
  // remove a context - and a root variable named qlint is the user's (#1871).
  await value(c, ".qlint:(enlist`cache)_.qlint;qlint:7");
  readInstalled(await c.call(installLambda("cov"), ["f"], [states.get("f").text], [covered[0].text], 2), 1);
  readRestored(await c.call(restoreExpression("cov")));
  assert.strictEqual(await value(c, "(key[`.qlint]~enlist`)&qlint~7"), true);
  // Nothing to restore is not an error.
  assert.deepStrictEqual(readRestored(await c.call(restoreExpression("cov"))).kept, []);
});

test("a function that changed on the process, or is not there, is not replaced", { skip }, async (t) => {
  const { connection: c } = await connect(t, "f:{x+1}\n");
  const statuses = readInstalled(
    await c.call(installLambda("cov"), ["f", "g", "f"], ["{x+2}", "{x}", "{x+1}"], ["{x+3}", "{x}", "{x+"], 0),
    3,
  );
  assert.deepStrictEqual(statuses.slice(0, 2), ["changed", "missing"]);
  assert.notStrictEqual(statuses[2], "ok", "text that does not parse is reported, not defined");
  // Nothing was replaced, so nothing is kept to put back with: .qlint.cov
  // is gone already, whether or not a restore follows (#1893).
  assert.strictEqual(await value(c, "key[`.qlint]~enlist`"), true);
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("err"), ["g"], ["{x}"], ["{x}"], 0), 1), ["missing"]);
  assert.strictEqual(await value(c, "key[`.qlint]~enlist`"), true);
  // One replaced of two: kept until the restore.
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("cov"), ["f", "g"], ["{x+1}", "{x}"], ["{x+1}", "{x}"], 0), 2), ["ok", "missing"]);
  assert.strictEqual(await value(c, "key[`.qlint]~``cov"), true);
  readRestored(await c.call(restoreExpression("cov")));
  assert.strictEqual(await value(c, "last value f"), "{x+1}");
});

test("a coverage probe leaves its function callable where q refuses a global write: under reval it is not counted, and still answers (#1894)", { skip }, async (t) => {
  const { connection: c } = await connect(t, "sq:{[x] y:x*x; y}\nbad:{[x] x+`a}\n");
  const call = "reval(`sq;3)";
  assert.strictEqual(Number(await value(c, call)), 9);
  const covered = [coverageText("{[x] y:x*x; y}", 0), coverageText("{[x] x+`a}", 2)];
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("cov"), ["sq", "bad"], ["{[x] y:x*x; y}", "{[x] x+`a}"], covered.map((x) => x.text), 3), 2), ["ok", "ok"]);
  // A gateway's read-only evaluation: the probe's own write is refused
  // ('noupdate), and that is not the caller's error.
  assert.strictEqual(Number(await value(c, call)), 9);
  // Where it can write it counts, and the function's own error is still its error.
  assert.strictEqual(Number(await value(c, "sq 4")), 16);
  await assert.rejects(value(c, "bad 1"), /type/);
  const restored = readRestored(await c.call(restoreExpression("cov")));
  assert.deepStrictEqual(restored.d.map(Number), [1, 1, 1]);
  assert.deepStrictEqual(await value(c, "(last value sq;key[`.qlint]~enlist`)"), ["{[x] y:x*x; y}", true]);
});

// Each probe held its own index as a constant: a function of 120
// statements with a literal each was refused 'limit once instrumented (#2543).
test("a function of 150 statements with literals is instrumented, and each statement counted once (#2543)", { skip }, async (t) => {
  const body = Array.from({ length: 150 }, (_, i) => `a:a+${i + 1000}`).join(";");
  const src = `{[x] a:x;${body};a}`;
  const { connection: c } = await connect(t, `long:${src}\n`);
  const want = Number(await value(c, "long 0"));
  const cov = coverageText(src, 3);
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("cov"), ["long"], [src], [cov.text], 3 + cov.statements.length), 1), ["ok"]);
  assert.strictEqual(Number(await value(c, "long 0")), want);
  const restored = readRestored(await c.call(restoreExpression("cov")));
  assert.deepStrictEqual(restored.d.map(Number), [0, 0, 0, ...cov.statements.map(() => 1)]);
});

test("the locals capture keeps the arguments and locals up to the error", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "\\l lib.q\n", { "lib.q": "\\d .ns\nm:{[a;b]\n  c:a+b;\n  d:c*2;\n  d+`x}\n\\d .\n" });
  const [def] = definitions(fs.readFileSync(path.join(dir, "lib.q"), "utf8"));
  const captured = localsText(def.text);
  const was = await value(c, "last value .ns.m");
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("err"), [def.name], [was], [captured.text], 0), 1), ["ok"]);
  const answer = readAnswer(await c.call(RUN, [".ns.m[1;2]"], [25, 80]));
  assert.strictEqual(answer.ok, false);
  assert.strictEqual(answer.error, "type");
  const { d, kept } = readRestored(await c.call(restoreExpression("err")));
  assert.deepStrictEqual(kept, []);
  assert.strictEqual(Number(d.at), 2);
  assert.deepStrictEqual(d.args, { a: "1", b: "2" });
  assert.deepStrictEqual(d.locals, { c: "3", d: "6" });
  assert.strictEqual(await value(c, "last value .ns.m"), was);
  // Back in its own context, and nothing of q-lint's left.
  assert.deepStrictEqual(await value(c, "(`ns~first(value .ns.m)3;key[`.qlint]~enlist`)"), [true, true]);
});

// The locals were kept in a dictionary started empty, which took the type of
// the first atom kept: a local of another type then failed with 'type
// inside the function, in place of the error being looked into (#2968).
test("the locals capture keeps locals of different types, and one assigned again with another (#2968)", { skip }, async (t) => {
  const { connection: c } = await connect(t, "m:{[x] n:count x; s:`$string n; n:`again; s+1}\nfine:{[x] p:x; q:\"ab\"; p}\n");
  const capture = async (name, call) => {
    const was = await value(c, `last value ${name}`);
    assert.deepStrictEqual(readInstalled(await c.call(installLambda("err"), [name], [was], [localsText(was).text], 0), 1), ["ok"]);
    const answer = readAnswer(await c.call(RUN, [call], [25, 80]));
    return { answer, d: readRestored(await c.call(restoreExpression("err"))).d };
  };
  const failed = await capture("m", "m 1 2 3");
  // The function's own error, at its own statement.
  assert.strictEqual(failed.answer.error, "type");
  assert.strictEqual(Number(failed.d.at), 3);
  assert.deepStrictEqual(failed.d.locals, { n: "`again", s: "`3" });
  const ran = await capture("fine", "fine 5");
  assert.strictEqual(ran.answer.ok, true, ran.answer.error);
  assert.deepStrictEqual(ran.d.locals, { p: "5", q: '"ab"' });
  // A call that assigned nothing has no locals.
  const none = await capture("fine", "1+1");
  assert.deepStrictEqual(none.d.locals, {});
});

// A typed parameter list is the one q reads: the capture goes after it, and
// keeps each name it binds. Before, the instrumented lambda failed with 'a
// and captured nothing (#2332).
test("the locals capture of a lambda with typed or pattern parameters keeps what each binds (#2332)", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "\\l lib.q\n", { "lib.q": "m:{[a:`j;(p;q)]\n  r:a+p+q;\n  r+`x}\n" });
  const [def] = definitions(fs.readFileSync(path.join(dir, "lib.q"), "utf8"));
  const captured = localsText(def.text);
  assert.deepStrictEqual(captured.params, ["a", "p", "q"]);
  const was = await value(c, "last value m");
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("err"), [def.name], [was], [captured.text], 0), 1), ["ok"]);
  const answer = readAnswer(await c.call(RUN, ["m[1;2 3]"], [25, 80]));
  assert.strictEqual(answer.ok, false);
  assert.strictEqual(answer.error, "type");
  const { d } = readRestored(await c.call(restoreExpression("err")));
  assert.deepStrictEqual(d.args, { a: "1", p: "2", q: "3" });
  assert.deepStrictEqual(d.locals, { r: "6" });
});

test("a captured local is text to 2000 characters, whatever the process's \\c (#1870)", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "\\l lib.q\n\\c 25 40\n", { "lib.q": "\\d .ns\nw:{[a;b]\n  c:til a;\n  d:([] x:c; y:b);\n  d+`x}\n\\d .\n" });
  const [def] = definitions(fs.readFileSync(path.join(dir, "lib.q"), "utf8"));
  const was = await value(c, "last value .ns.w");
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("err"), [def.name], [was], [localsText(def.text).text], 0), 1), ["ok"]);
  assert.strictEqual(readAnswer(await c.call(RUN, [".ns.w[60;`sym]"], [25, 40])).ok, false);
  const { d } = readRestored(await c.call(restoreExpression("err")));
  const n = Array.from({ length: 60 }, (_, i) => i).join(" ");
  assert.deepStrictEqual(d.args, { a: "60", b: "`sym" });
  assert.deepStrictEqual(d.locals, { c: n, d: `+\`x\`y!(${n};${Array(60).fill("`sym").join("")})` });
  assert.deepStrictEqual(await value(c, "(system\"c\";key[`.qlint]~enlist`)"), [[25, 40], true]);
});


// One capture for the whole process held the arguments and locals of
// whichever call ran last: a function that calls itself, failing after the
// inner call returned, showed the inner call's (#2969).
test("the locals capture shows the call that failed, not the last call a recursive function made (#2969)", { skip }, async (t) => {
  const { connection } = await connect(
    t,
    [
      "walk:{[depth;node] kids:node`kids; r:walk[depth+1] each kids; $[depth=0;r,`bad+1;r,depth]}",
      "early:{[n] if[n=0; :0]; m:early n-1; $[n=2;m+`bad;m]}",
      "deep:{[n] v:$[n=3;`bad+1;n]; deep n+1}",
      "safe:{[n] a:n+1; r:@[safe;`bad;{[e] -1}]; a+`bad}",
    ].join("\n") + "\n",
  );
  const capture = async (name, call) => {
    const state = readDrift(await connection.call(DRIFT, name)).get(name);
    const captured = localsText(state.text);
    readInstalled(await connection.call(installLambda("err"), [name], [state.text], [captured.text], 0), 1);
    const error = await connection.call(`{[x] @[value;x;{x}]}`, call);
    const d = readRestored(await connection.call(restoreExpression("err"))).d;
    assert.strictEqual(await connection.call("{[x] `err in key`.qlint}", 0), false);
    return { error, args: d.args, locals: d.locals, at: Number(d.at) };
  };
  // The outermost call fails after the inner one returned.
  assert.deepStrictEqual(await capture("walk", "walk[0;`kids`v!(enlist `kids`v!(();1);0)]"), {
    error: "type",
    args: { depth: "0", node: "`kids`v!(+`kids`v!(,();,1);0)" },
    locals: { kids: "+`kids`v!(,();,1)", r: ",,1" },
    at: 2,
  });
  // The inner calls returned early, through `:`.
  assert.deepStrictEqual(await capture("early", "early 3"), { error: "type", args: { n: "2" }, locals: { m: "0" }, at: 2 });
  // The innermost call fails: its frame, not the first call's.
  assert.deepStrictEqual(await capture("deep", "deep 0"), { error: "type", args: { n: "3" }, locals: {}, at: 0 });
  // A call whose error a caller trapped is not the one shown.
  assert.deepStrictEqual(await capture("safe", "safe 5"), { error: "type", args: { n: "5" }, locals: { a: "6", r: "-1" }, at: 2 });
});
