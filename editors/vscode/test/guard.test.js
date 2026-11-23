// The read-only guard (#918) as data: which processes it guards, and what
// in q code it takes for a change. Run after `tsc`; guard_vscode.test.js
// drives every path that sends code through it.
const test = require("node:test");
const assert = require("node:assert");
const { DEFAULT_GUARD_TAGS, guardCheck, guardQuestion, guardRefusal, guardedBy, readGuard, writes } = require("../out/guard.js");

const settings = (values = {}) => readGuard((key, fallback) => (key in values ? values[key] : fallback));

test("the guard is on by default, for prod, prd and production, ignoring case", () => {
  assert.deepStrictEqual(settings(), { enabled: true, tags: ["prod", "prd", "production"] });
  assert.deepStrictEqual(DEFAULT_GUARD_TAGS, ["prod", "prd", "production"]);
  assert.deepStrictEqual(guardedBy({ tags: ["eu", "PROD"] }, settings()), ["PROD"]);
  assert.deepStrictEqual(guardedBy({ tags: ["dev"] }, settings()), []);
  // Configurable: another tag, and an empty list guards nothing.
  assert.deepStrictEqual(guardedBy({ tags: ["live"] }, settings({ "processes.readOnlyGuard.tags": [" Live "] })), ["live"]);
  assert.deepStrictEqual(guardedBy({ tags: ["prod"] }, settings({ "processes.readOnlyGuard.tags": [] })), []);
  // A list that is not one of strings is the default one; "false" is not off.
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": "prod" }).tags, DEFAULT_GUARD_TAGS);
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": [1] }).tags, DEFAULT_GUARD_TAGS);
  assert.strictEqual(settings({ "processes.readOnlyGuard.enable": "false" }).enabled, true);
});

test("turned off, the guard guards nothing", () => {
  const off = settings({ "processes.readOnlyGuard.enable": false });
  assert.deepStrictEqual(guardedBy({ tags: ["prod"] }, off), []);
  assert.strictEqual(guardCheck("a:1", [{ label: "p", tags: ["prod"] }], off), undefined);
});

test("assignments to globals are changes; locals, columns and table literals are not", () => {
  const cases = {
    "a:1": ["assigns a"],
    "a::b+1": ["assigns a"],
    "a+:1": ["assigns a"],
    "a ,: 2": ["assigns a"],
    "t[0]:5": ["assigns t"],
    "x:select a:b from t": ["assigns x"],
    // In a lambda only `::` and a dotted name reach a global, as q has it.
    "f:{loc:1; .ns.v:2; g::3}": ["assigns f", "assigns .ns.v", "assigns g"],
    "{loc:1; x+1}[2]": [],
    "$[c;b:1;2]": ["assigns b"],
    "select a:x by b:y from t where c>1": [],
    "exec a:x by b:y from t": [],
    "([] a:1 2; b:3)": [],
    "([k:1 2] v:3 4)": [],
    "select from trade": [],
    "count `a:b": [],
    "1 2!3 4": [],
    "x-1": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("in-place updates, writers, file writes and amends are changes", () => {
  const cases = {
    "update a:1 from `t": ["updates `t in place"],
    "update a:1 from t": [],
    "delete x from `.": ["deletes from the root namespace"],
    "delete from `t where a>1": ["deletes from `t in place"],
    "delete from t": [],
    "`a set 1": ["calls set"],
    "`t upsert (1;2)": ["calls upsert"],
    "`t insert (1;2)": ["calls insert"],
    "hdel `:f": ["calls hdel"],
    "exit 0": ["calls exit"],
    "hclose h": ["calls hclose"],
    "-11!`:tp.log": ["replays a log with -11!"],
    "-11!(5;`:tp.log)": ["replays a log with -11!"],
    "-11!(-1;`:tp.log)": [],
    "-11!(-2;`:tp.log)": [],
    'system "rm x"': ["calls system"],
    ".Q.dpft[`:db;2024.01.01;`sym;`t]": ["calls .Q.dpft"],
    '`:f 0: ("a")': ["writes the file `:f with 0:"],
    "`:f 1: 0x01": ["writes the file `:f with 1:"],
    '("SJ";",") 0: `:f.csv': [],
    "f:`lib 2:(`f;1)": ["assigns f", "loads a shared object with 2:"],
    "@[`t;0;:;1]": ["amends `t in place"],
    ".[`t;(0;`a);:;1]": ["amends `t in place"],
    // A trap by name is not an amend.
    ".[`f;(1;2);{x}]": [],
    "@[f;x;{y}]": [],
    'value "a:1"': ["evaluates a string with value"],
    "value d": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a functional update or delete on a global table is a change (#1064)", () => {
  const cases = {
    "![`trade;();0b;enlist`price]": ["updates or deletes from `trade in place with !"],
    "![`trade;enlist(=;`sym;enlist`a);0b;`symbol$()]": ["updates or deletes from `trade in place with !"],
    "f:{![`trade;();0b;`symbol$()]}": ["assigns f", "updates or deletes from `trade in place with !"],
    // On a value it returns a new table; three arguments is not one.
    "![trade;();0b;enlist`price]": [],
    "![`trade;();0b]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("save, rsave, dsave, load, rload, .Q.chk and .Q.dsftg are changes (#1065)", () => {
  const cases = {
    "save `trade": ["calls save"],
    "rsave `trade": ["calls rsave"],
    "`:/tmp/db/ dsave `trade": ["calls dsave"],
    "load `:trade": ["calls load"],
    "rload `:trade": ["calls rload"],
    ".Q.chk `:/hdb": ["calls .Q.chk"],
    ".Q.dsftg[(`:db;2024.01.01;`trade);(`:src;0;0);`a`b!\"jf\"]": ["calls .Q.dsftg"],
    // Reads stay reads.
    "get `:hdb/sym": [],
    "get `t": [],
    "value `t": [],
    "select from t where sym=`a": [],
    "exec price from t": [],
    ".my.load[`x]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("get, eval of a parse tree and value through each or brackets are evaluations (#1066)", () => {
  const cases = {
    'get "trade:()"': ["evaluates a string with get"],
    'value["trade:()"]': ["evaluates a string with value"],
    'value each ("a:1";"b:2")': ["evaluates a string with value"],
    "value'[(\"a:1\";\"b:2\")]": ["evaluates a string with value"],
    'eval parse "trade:()"': ["evaluates a parse tree with eval"],
    "eval(:;`trade;())": ["evaluates an assignment with eval"],
    "eval (::;`trade;())": ["evaluates an assignment with eval"],
    // Still reads.
    "eval (+;1;2)": [],
    "value each d": [],
    "get each `:a`:b": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("0: and 1: to a computed file handle are file writes (#1067)", () => {
  const cases = {
    'hsym[`f] 0: enlist "x"': ["writes a file with 0:"],
    "(hsym`f) 1: 0x00": ["writes a file with 1:"],
    "hsym `f 1: 0x00": ["writes a file with 1:"],
    '(`:f) 0: enlist "x"': ["writes a file with 0:"],
    // A parse format before 0: or 1: reads.
    '("SJ";enlist ",") 0: `:f.csv': [],
    '("SJ";",") 0: hsym `f': [],
    '(4#"i";4) 1: `:f': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("system commands are changes, except bare reads of a setting; \\t is read for its expression", () => {
  const cases = {
    "\\l file.q": ["runs the system command \\l"],
    "\\cd /tmp": ["runs the system command \\cd"],
    "\\\\": ["runs the system command \\\\"],
    "\\c 20 200": ["runs the system command \\c"],
    "\\c": [],
    "\\d": [],
    "\\P": [],
    "\\cd": [],
    "\\t til 10": [],
    "\\t 500": ["sets the timer with \\t"],
    "\\t:100 5": [],
    "\\t:100 a:1": ["assigns a"],
    "\\ts a:1": ["assigns a"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("strings and comments are not read; every statement is, each reason once", () => {
  assert.deepStrictEqual(writes('"a:1"'), []);
  assert.deepStrictEqual(writes("`a:1"), []);
  assert.deepStrictEqual(writes("x / a:1"), []);
  assert.deepStrictEqual(writes("/ a:1\nb"), []);
  assert.deepStrictEqual(writes("/\na:1\n\\\nb"), []);
  assert.deepStrictEqual(writes('s:"a\\"b:1"'), ["assigns s"]);
  assert.deepStrictEqual(writes("select from t\na:1\na:2\n\\l x.q"), ["assigns a", "runs the system command \\l"]);
});

test("the check names the guarded processes and what the code does; the question and the refusal say so", () => {
  const on = settings();
  const prod = { label: "rdb", tags: ["prod"] };
  const dev = { label: "dev", tags: ["dev"] };
  assert.strictEqual(guardCheck("select from t", [prod], on), undefined);
  assert.strictEqual(guardCheck("a:1", [dev], on), undefined);
  const check = guardCheck("a:1;\\l x.q", [dev, prod], on);
  assert.deepStrictEqual(check, { guarded: [{ label: "rdb", tags: ["prod"] }], reasons: ["assigns a"] });
  assert.deepStrictEqual(guardQuestion(check), {
    message: "This code would change rdb. Run it anyway?",
    detail: "rdb is tagged prod, which q-lint.processes.readOnlyGuard.tags guards. The code assigns a.",
  });
  const two = guardCheck("a:1", [prod, { label: "hdb", tags: ["PRD"] }], on);
  assert.strictEqual(guardQuestion(two).message, "This code would change 2 read-only processes. Run it anyway?");
  assert.match(guardQuestion(two).detail, /^rdb, hdb are tagged prod, PRD/);
  assert.match(guardRefusal(check), /^Nothing was run: rdb is read-only guarded \(tagged prod; q-lint.processes.readOnlyGuard.tags\), and the query assigns a\./);
});

test("a string given to a TorQ gateway's .gw.syncexec is read as code sent to its servers (#909)", () => {
  assert.deepStrictEqual(writes(".gw.syncexec[\"delete from `t\";enlist `rdb]"), ["deletes from `t in place through .gw.syncexec"]);
  // Several statements, as the gateway wrap sends them, with q's escapes.
  assert.deepStrictEqual(writes('.gw.syncexec[({last value each x};("select from t";"a:\\"x\\""));`rdb`hdb]'), ["assigns a through .gw.syncexec"]);
  assert.deepStrictEqual(writes(".gw.asyncexec[\"`t upsert 1\";`rdb]"), ["calls upsert through .gw.asyncexec"]);
  // One that only reads is not asked about.
  assert.deepStrictEqual(writes(".gw.syncexec[\"select from t\";`rdb]"), []);
  assert.deepStrictEqual(writes('.gw.syncexec[enlist "t";enlist `rdb]'), []);
});
