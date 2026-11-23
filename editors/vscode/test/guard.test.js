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

test("a writer named through .q. is a change; a .q. reader is not (#1220)", () => {
  const cases = {
    ".q.set[`a;1]": ["calls .q.set"],
    '.q.system "echo x"': ["calls .q.system"],
    "`t .q.upsert (1;2)": ["calls .q.upsert"],
    '.q.value "a:1"': ["evaluates a string with .q.value"],
    // Reads stay reads.
    ".q.count t": [],
    ".q.get `:hdb/sym": [],
    ".q.value `t": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("value, get or eval of a list headed by a writer's symbol is a change (#1221)", () => {
  const cases = {
    "value(`.q.set;`a;1)": ["evaluates a call of .q.set with value"],
    "eval(`.q.set;enlist`zz;7)": ["evaluates a call of .q.set with eval"],
    "get(`.q.upsert;`t;(1;2))": ["evaluates a call of .q.upsert with get"],
    // A list headed by a reader, or by a symbol that is data, reads.
    "value(`.q.count;til 3)": [],
    "eval(`f;1)": [],
    "value `t": [],
    "get `:hdb/sym": [],
    "value(`t;`u)": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a table symbol in parentheses after from or in an amend is a change (#1222)", () => {
  const cases = {
    "update a:1 from (`t)": ["updates `t in place"],
    "delete from ((`t)) where a>1": ["deletes from `t in place"],
    ".[(`t);();,;1]": ["amends `t in place"],
    "@[(`t);0;:;1]": ["amends `t in place"],
    "![(`t);();0b;enlist`a]": ["updates or deletes from `t in place with !"],
    // A value in parentheses, or a list of symbols, is not the table by name.
    "update a:1 from (t)": [],
    "select from (`t)": [],
    "exec a from (`t)": [],
    "@[(`a;`b);0;:;1]": [],
    ".[(t);();,;1]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("-19! compresses into a file and is a change (#1223)", () => {
  assert.deepStrictEqual(writes("-19!(`:src;`:dst;17;2;6)"), ["writes a compressed file with -19!"]);
  assert.deepStrictEqual(writes("x:-19!(`:src;`:dst;17;2;6)"), ["assigns x", "writes a compressed file with -19!"]);
  // -21! reads compression stats; a subtraction is not -19!.
  assert.deepStrictEqual(writes("-21!`:dst"), []);
  assert.deepStrictEqual(writes("a-19"), []);
});

test("hopen of a file handle is a change; of a process handle it only connects (#1224)", () => {
  const cases = {
    '(hopen `:/tmp/hx.txt) "hello"': ["opens the file `:/tmp/hx.txt with hopen"],
    "hopen `:hx.txt": ["opens the file `:hx.txt with hopen"],
    "hopen[`:/tmp/x]": ["opens the file `:/tmp/x with hopen"],
    ".q.hopen `:log.txt": ["opens the file `:log.txt with .q.hopen"],
    // A connection is not a change by itself; what is sent over it is not read.
    "hopen `:host:5000": [],
    "hopen `::5000": [],
    "hopen (`:localhost:5000:user:pass;1000)": [],
    "hopen `:unix://5000": [],
    "hopen `:tcps://host:5000": [],
    "hopen 5000": [],
    'h "select from t"': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test(".Q.ens enumerates into a sym file and is a change (#1256)", () => {
  assert.deepStrictEqual(writes(".Q.ens[`:db;([]s:`x`y);`sym]"), ["calls .Q.ens"]);
});

test("setenv and the .Q writers that save, enumerate, load or narrow an HDB are changes (#1329)", () => {
  const cases = {
    ".Q.dpt[`:db;2024.01.01;`t]": ["calls .Q.dpt"],
    ".Q.dpts[`:db;2024.01.01;`t;`sym]": ["calls .Q.dpts"],
    ".Q.view 2024.01.01": ["calls .Q.view"],
    ".Q.l `:hdb": ["calls .Q.l"],
    ".Q.lo[`:hdb;0;0]": ["calls .Q.lo"],
    ".Q.bv[]": ["calls .Q.bv"],
    '.Q.opt enlist "-x"': ["calls .Q.opt"],
    '`HOME setenv "/tmp"': ["calls setenv"],
    ".Q.enx[$;`:db;([]s:`x`y)]": ["calls .Q.enx"],
    ".Q.enxs[$;`:db;([]s:`x`y);`sym]": ["calls .Q.enxs"],
    // Reads stay reads.
    'getenv `HOME': [],
    ".Q.pv": [],
    ".Q.s1 t": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("bare \\_, \\r and \\E, and \\w 0 or 1, only read (#1332)", () => {
  const cases = {
    "\\_": [],
    "\\r": [],
    "\\E": [],
    "\\w 0": [],
    "\\w 1": [],
    // With an argument they change the process.
    "\\_ x.q": ["runs the system command \\_"],
    "\\r a b": ["runs the system command \\r"],
    "\\w 1000000": ["runs the system command \\w"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("system of a literal is read as the command it runs (#1331)", () => {
  const cases = {
    'system"c"': [],
    'system "w"': [],
    'system["P"]': [],
    '.q.system "d"': [],
    'x:system "c"': ["assigns x"],
    // A command that changes, or one built at run time, is a change.
    'system "c 20 200"': ["calls system"],
    'system "l x.q"': ["calls system"],
    'system "c ",string 20': ["calls system"],
    "system cmd": ["calls system"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("xasc, xdesc and xkey on a table named by a symbol change it in place (#1330)", () => {
  const cases = {
    "`a xasc `t": ["sorts `t in place with xasc"],
    "`a xdesc `t": ["sorts `t in place with xdesc"],
    "`a xkey `t": ["keys `t in place with xkey"],
    "xasc[`a;`t]": ["sorts `t in place with xasc"],
    // On a value they return a new table.
    "`a xasc t": [],
    "`a`b xdesc select from t": [],
    "xasc[`a;t]": [],
    "`a xkey t": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("? with a symbol atom on its left extends an enumeration (#1315)", () => {
  const cases = {
    "`s?`x`y": ["extends the enumeration `s with ?"],
    "`:db/sym?`x`y": ["extends the enumeration `:db/sym with ?"],
    "`.ns.e ? `p`q": ["extends the enumeration `.ns.e with ?"],
    // A find in a list, a value or a functional select reads.
    "`a`b`c?`b": [],
    "s?`x": [],
    "`s$`x": [],
    "?[`t;();0b;()]": [],
    "x?`a": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a string sent to handle 0 is evaluated by the process (#1316)", () => {
  const cases = {
    '0"a:1"': ["evaluates a string on handle 0"],
    '0 "a::5"': ["evaluates a string on handle 0"],
    '(0)"a:1"': ["evaluates a string on handle 0"],
    'neg[0]"a::5"': ["evaluates a string on handle 0"],
    '-0"a::5"': ["evaluates a string on handle 0"],
    // Writing to stdout, a read of a file, or a number reads.
    '1"hello"': [],
    '-1 "hello"': [],
    '("SJ";",") 0: `:f.csv': [],
    "0 1 2": [],
    'x[0]"a"': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});
