// The read-only guard (#918) as data: which processes it guards, and what
// in q code it takes for a change. Run after `tsc`; guard_vscode.test.js
// drives every path that sends code through it.
const test = require("node:test");
const assert = require("node:assert");
const { DEFAULT_GUARD_TAGS, guardCheck, guardQuestion, guardRefusal, guardedBy, openTags, readGuard, writes } = require("../out/guard.js");

const settings = (values = {}) => readGuard((key, fallback) => (key in values ? values[key] : fallback));

test("the guard is on by default, for prod, prd and production, ignoring case", () => {
  assert.deepStrictEqual(settings(), { enabled: true, tags: ["prod", "prd", "production"] });
  assert.deepStrictEqual(DEFAULT_GUARD_TAGS, ["prod", "prd", "production"]);
  assert.deepStrictEqual(guardedBy({ tags: ["eu", "PROD"] }, settings()), ["PROD"]);
  assert.deepStrictEqual(guardedBy({ tags: ["dev"] }, settings()), []);
  // Configurable: another tag, and an empty list guards nothing.
  assert.deepStrictEqual(guardedBy({ tags: ["live"] }, settings({ "processes.readOnlyGuard.tags": [" Live "] })), ["live"]);
  assert.deepStrictEqual(guardedBy({ tags: ["prod"] }, settings({ "processes.readOnlyGuard.tags": [] })), []);
  // A string is a list of tags, and a list keeps its strings: the user's
  // own tags are never dropped for the defaults (#2519). A setting that
  // names no tag is the default list; "false" is not off.
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": "live" }).tags, ["live"]);
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": "live, desk" }).tags, ["live", "desk"]);
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": ["live", 2026] }).tags, ["live"]);
  assert.deepStrictEqual(guardedBy({ tags: ["live"] }, settings({ "processes.readOnlyGuard.tags": ["live", null] })), ["live"]);
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": [1] }).tags, DEFAULT_GUARD_TAGS);
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": "" }).tags, DEFAULT_GUARD_TAGS);
  assert.deepStrictEqual(settings({ "processes.readOnlyGuard.tags": 7 }).tags, DEFAULT_GUARD_TAGS);
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
    // On a symbol three arguments amend too; on a value it is a trap.
    ".[`f;(1;2);{x}]": ["amends `f in place"],
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

test(".Q.Xf creates a file and .Q.li loads partitions: both are changes (#1423)", () => {
  assert.deepStrictEqual(writes(".Q.Xf[`C;`:f]"), ["calls .Q.Xf"]);
  assert.deepStrictEqual(writes(".Q.li 2024.01.02"), ["calls .Q.li"]);
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
    // Parenthesised, applied with @ or ., or enlisted (#1424).
    '0("a:1")': ["evaluates a string on handle 0"],
    '0@"a:1"': ["evaluates a string on handle 0"],
    '0 . enlist "a:1"': ["evaluates a string on handle 0"],
    '(neg 0)"a:1"': ["evaluates a string on handle 0"],
    '(0)@"a:1"': ["evaluates a string on handle 0"],
    // Applied in brackets (#1724).
    '0["a:1"]': ["evaluates a string on handle 0"],
    '(0)["a:1"]': ["evaluates a string on handle 0"],
    'neg[0]["a:1"]': ["evaluates a string on handle 0"],
    // Writing to stdout, a read of a file, or a number reads.
    '1"hello"': [],
    '-1 "hello"': [],
    '("SJ";",") 0: `:f.csv': [],
    "0 1 2": [],
    'x[0]"a"': [],
    "0(1;2)": [],
    'x[0]("a")': [],
    'x[0]["a"]': [],
    '1["hello"]': [],
    "0[1]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an assignment inside a table literal's column expression is a change (#1317)", () => {
  const cases = {
    "([] c:(g:5)+1 2)": ["assigns g"],
    "([] c:1 2; d:g:3)": ["assigns g"],
    "([k:(g:1)+0] v:2)": ["assigns g"],
    // The column names themselves are not.
    "([] a:1 2; b:3)": [],
    "([k:1 2] v:3 4)": [],
    "([k:1 2; j:3 4] v:5 6; w:7 8)": [],
    "([] a:([] b:1 2))": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a destructuring assignment assigns each name (#1318)", () => {
  const cases = {
    "(a;b):(1;2)": ["assigns a", "assigns b"],
    "(a;b):1 2": ["assigns a", "assigns b"],
    "(a;.ns.b):1 2": ["assigns a", "assigns .ns.b"],
    // In a lambda the names are local, as q has it.
    "{(a;b):x}[1 2]": [],
    // A list of names that is not assigned reads.
    "(a;b)": [],
    "(a;b)~(1;2)": [],
    "f[a;b]:1": ["assigns f"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("in a lambda, an indexed or compound assignment to a name not its own changes the global (#1319)", () => {
  const cases = {
    "{a+:1}[]": ["assigns a"],
    "{a-:1}[]": ["assigns a"],
    "{t[0]:5}[]": ["assigns t"],
    "{t[0;`a]:99}[]": ["assigns t"],
    "{[x] t,:([]a:enlist x)}[9]": ["assigns t"],
    "f:{n+:1}": ["assigns f", "assigns n"],
    // A parameter, or a name the lambda assigns anywhere, is local.
    "{x+:1}[2]": [],
    "{[a] a+:1}[2]": [],
    "{l:1 2; l[0]:9; l}[]": [],
    "{l+:1; l:2}[]": [],
    "{(a;b):x; a+:1}[1 2]": [],
    // A local of an outer lambda is not one of an inner one's.
    "{a:1; {a+:1}[]}[]": ["assigns a"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a writer reached by indexing .q is a change (#1254)", () => {
  const cases = {
    ".q[`set][`b;2]": ["calls .q.set"],
    ".Q[`dpft][`:db;2024.01.01;`sym;`t]": ["calls .Q.dpft"],
    // A reader indexed out of .q reads.
    ".q[`count] t": [],
    ".Q[`s1] t": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a writer named by its symbol and applied is a change (#1320)", () => {
  const cases = {
    "`.q.set . (`a;1)": ["calls .q.set"],
    "(`.q.set)[`a;1]": ["calls .q.set"],
    "(get `.q.set)[`a;1]": ["calls .q.set"],
    "`.q.upsert . (`t;([]a:enlist 7))": ["calls .q.upsert"],
    '`.q.system "cd /tmp"': ["calls .q.system"],
    "(`.q.hdel) `:tf.txt": ["calls .q.hdel"],
    "`.Q.dpft . (`:db;2024.01.01;`sym;`t)": ["calls .Q.dpft"],
    // Said once when value applies it.
    "value(`.q.set;`a;1)": ["evaluates a call of .q.set with value"],
    // A reader's symbol, or a plain symbol, reads.
    "`.q.count . enlist til 3": [],
    "select from t where f=`set": [],
    "`set`upsert": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a gateway call applied with . or @ is read inside its strings (#1255)", () => {
  const cases = {
    '.gw.syncexec . ("e:5";`rdb)': ["assigns e through .gw.syncexec"],
    '.gw.asyncexec .("`t upsert 1";`rdb)': ["calls upsert through .gw.asyncexec"],
    '.gw.syncexec["a:1";`rdb]; .gw.syncexec . ("b:2";`rdb)': ["assigns a through .gw.syncexec", "assigns b through .gw.syncexec"],
    // A read, and a string after the call's expression, are not.
    '.gw.syncexec . ("select from t";`rdb)': [],
    '(.gw.syncexec . ("select from t";`rdb)); x:"a:1"': ["assigns x"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("value, get or eval applied with @, . or in parentheses evaluates (#1325)", () => {
  const cases = {
    'value@"q:1"': ["evaluates a string with value"],
    'value . enlist "a:1"': ["evaluates a string with value"],
    '(value)"a:1"': ["evaluates a string with value"],
    'get@"a:1"': ["evaluates a string with get"],
    'value enlist["a:1"]': ["evaluates a string with value"],
    // Applied to a value they read.
    "value@`t": [],
    "(value)`t": [],
    "value . enlist `t": [],
    "value{x}": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a string run through a trap is evaluated (#1253)", () => {
  const cases = {
    '@[value;"c:3";::]': ["evaluates a string with value"],
    '.[value;enlist "c:3";{x}]': ["evaluates a string with value"],
    '.Q.trp[value;"c:3";{x}]': ["evaluates a string with value"],
    '@[eval;parse "c:3";::]': ["evaluates a parse tree with eval"],
    "@[eval;(:;`c;3);::]": ["evaluates an assignment with eval"],
    // A value trapped, and a default that is a string, read.
    "@[value;`t;::]": [],
    '@[value;`t;""]': [],
    "@[get;`:hdb/sym;()]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("eval of a compound-assignment or ! tree, -6! and -5! evaluate (#1324)", () => {
  const cases = {
    "eval(+:;`a;1)": ["evaluates an assignment with eval"],
    "eval(,:;`t;([]a:enlist 9))": ["evaluates an assignment with eval"],
    "eval(!;enlist`t;();0b;`symbol$())": ["evaluates a functional update or delete with eval"],
    "value(!;`t;();0b;`symbol$())": ["evaluates a functional update or delete with value"],
    "-6!(:;`a;1)": ["evaluates an assignment with -6!"],
    "-6!(+:;`a;5)": ["evaluates an assignment with -6!"],
    '-6!parse "a:1"': ["evaluates a parse tree with -6!"],
    'eval -5!"a:1"': ["evaluates a parse tree with eval"],
    'value -5!"a:7"': ["evaluates a parse tree with value"],
    // A tree that only computes, and -5! alone, read.
    "eval(+;1;2)": [],
    "-6!(+;1;2)": [],
    "eval(!;`t;();0b;`symbol$())": [],
    "value(!;enlist`t;();0b;`symbol$())": [],
    '-5!"a:1"': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("-19!, -11! and -6! spaced or with the number in parentheses are still changes (#1326)", () => {
  const cases = {
    "-19 !(`:tf;`:cz;17;2;6)": ["writes a compressed file with -19!"],
    "(-19)!(`:tf;`:cz;17;2;6)": ["writes a compressed file with -19!"],
    "-11 !`:tp.log": ["replays a log with -11!"],
    "(-11)!`:tp.log": ["replays a log with -11!"],
    "(-6)!(:;`a;1)": ["evaluates an assignment with -6!"],
    "-6 !(:;`a;1)": ["evaluates an assignment with -6!"],
    // Counting a log, a list ending in -19 made a dictionary, and a subtraction read.
    "-11 !(-1;`:tp.log)": [],
    "(-11)!(-2;`:tp.log)": [],
    "1 -19!2 3": [],
    "a-19!x": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("0: and 1: applied, or to a handle cast from a string, write a file (#1327)", () => {
  const cases = {
    "1:[`:tf.bin;0x0102]": ["writes the file `:tf.bin with 1:"],
    '0:[`:d.txt;("pp";"qq")]': ["writes the file `:d.txt with 0:"],
    '(0:)[`:e.txt;("pp";"qq")]': ["writes the file `:e.txt with 0:"],
    '.[0:;(`:g.txt;("pp";"qq"))]': ["writes the file `:g.txt with 0:"],
    '0:[hsym `h;enlist "x"]': ["writes the file `:h with 0:"],
    '(`$":c.txt") 0: ("pp";"qq")': ["writes a file with 0:"],
    // A parse format, applied or infix, reads.
    '0:[("SJ";",");`:f.csv]': [],
    '.[0:;(("SJ";",");`:f.csv)]': [],
    '("SJ";",") 0: `:f.csv': [],
    "1:[(4#\"i\";4);`:f]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("hopen of a file handle made with hsym, cast from a string or a string is a change (#1328)", () => {
  const cases = {
    "hopen hsym `nf": ["opens the file `:nf with hopen"],
    '(hopen hsym `nf) "abc"': ["opens the file `:nf with hopen"],
    'hopen `$":nf"': ["opens the file `:nf with hopen"],
    'hopen ":nf"': ["opens the file `:nf with hopen"],
    'hopen ":/tmp/x.txt"': ["opens the file `:/tmp/x.txt with hopen"],
    // A connection, however its handle is made, is not.
    "hopen hsym `$\"host:5000\"": [],
    "hopen `:host:5000": [],
    'hopen ":host:5000"': [],
    'hopen `$":localhost:5000"': [],
    "hopen hsym `host": ["opens the file `:host with hopen"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("the amend or ! passed as a value and applied to a list headed by a symbol is a change (#1321)", () => {
  const cases = {
    ".[@;(`.;`a;:;1)]": ["amends `. in place"],
    "(@) . (`.;`a;:;1)": ["amends `. in place"],
    ".[.;(`t;();,;1)]": ["amends `t in place"],
    ".[!;(`t;();0b;`symbol$())]": ["updates or deletes from `t in place with !"],
    // On a value, or with too few items, it reads.
    ".[@;(t;0;:;1)]": [],
    ".[!;(`a`b;1 2)]": [],
    "(@) . (x;0)": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an amend projection with the target left out and applied to a symbol is a change (#1322)", () => {
  const cases = {
    "@[;`a;:;1] `.": ["amends `. in place"],
    "@[;`a;:;1][`.]": ["amends `. in place"],
    ".[;();:;5] `a": ["amends `a in place"],
    // Applied to a value, it returns a copy.
    "@[;`a;:;1] d": [],
    ".[;();:;5]": [],
    "@[;0;{x}] x": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a three-argument amend on a symbol, with any function, is a change (#1763)", () => {
  const cases = {
    "@[`b;0;{9}]": ["amends `b in place"],
    ".[`b;();{9}]": ["amends `b in place"],
    "@[`b;::;1+]": ["amends `b in place"],
    "@[`t;`price;{x*2}]": ["amends `t in place"],
    ".[@;(`b;0;{9})]": ["amends `b in place"],
    "(@) . (`b;::;1+)": ["amends `b in place"],
    "value(@;`b;0;{9})": ["evaluates an amend with value"],
    // On a value, an index, or ! with three, it reads.
    "@[b;0;{9}]": [],
    ".[f;(1;2);{x}]": [],
    "@[`.;`a]": [],
    ".[@;(b;0;{9})]": [],
    "@[(`t)[0];1;{x}]": [],
    "@[(`d)`a;0;neg]": [],
    "![`t;();0b]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a three-argument amend with an attribute or a unary is a change (#1323)", () => {
  const cases = {
    "@[`t;`c;`p#]": ["amends `t in place"],
    "@[`t;`a;`s#]": ["amends `t in place"],
    "@[`t;`a;neg]": ["amends `t in place"],
    ".[`t;(0;`a);neg]": ["amends `t in place"],
    // On a value it reads; on a symbol it is never a trap (#1763).
    ".[`f;(1;2);{x}]": ["amends `f in place"],
    "@[`f;x;::]": ["amends `f in place"],
    "@[t;`c;`p#]": [],
    "![`t;();0b]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("ordinary reads stay reads after the round-6 rules", () => {
  for (const code of [
    "select from t",
    "select a,b from t where sym=`x",
    "exec price from t",
    "exec a by b from t",
    "get `:hdb/sym",
    "get `t",
    "value `t",
    "value t",
    "`a xasc t",
    "`a xdesc t",
    "`a`b xasc select from t",
    "hopen `:host:5000",
    'system"c"',
    'system "P"',
    "\\c",
    "\\w 0",
    "count t",
    "t?`x",
    "`a`b?`a",
    "x?3",
    "-1 \"hello\";",
    "1 \"hello\";",
    "{x+:1}[3]",
    "{[t] t[0]:1; t}[1 2]",
    "([] a:1 2; b:`x`y)",
    "@[f;x;{y}]",
    ".[f;(1;2);::]",
    "@[value;`t;::]",
    "(a;b)",
    '("SJ";enlist ",") 0: `:f.csv',
    "read0 `:f.txt",
    "eval parse_tree",
    "-21!`:dst",
  ]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("an in-place update whose column holds a subquery is a change (#1439)", () => {
  const cases = {
    "update c:(exec max a from s) from `t": ["updates `t in place"],
    "delete from `t where a in (select a from s)": ["deletes from `t in place"],
    "update c:(select max a by b from (exec a from s)) from `t": ["updates `t in place"],
    // A nested query on a value reads, and its columns are not assignments.
    "update c:(exec max a from s) from t": [],
    "select c:(exec max a from s) from t": [],
    "x:update c:(exec a:max a from s) from t": ["assigns x"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("0:, 1: and hopen to a handle built with ` sv, .Q.dd or hsym of a cast are changes (#1440)", () => {
  const cases = {
    "(` sv `:a`b) 1: 0x00": ["writes a file with 1:"],
    "(` sv dir,`f.csv) 0: lines": ["writes a file with 0:"],
    "(.Q.dd[`:a;`b]) 0: x": ["writes a file with 0:"],
    ".Q.dd[`:a;`b] 0: x": ["writes a file with 0:"],
    "hopen ` sv `:a`b": ["opens a file with hopen"],
    "hopen .Q.dd[`:a;`b]": ["opens a file with hopen"],
    'hopen hsym `$"/tmp/f"': ["opens the file `:/tmp/f with hopen"],
    // A parse format left of 0: on a built path, and a built connection, read.
    '("SJ";",") 0: ` sv `:a`b.csv': [],
    '("SJ";",") 0: .Q.dd[`:a;`b]': [],
    'hopen hsym `$"host:5000"': [],
    "hopen ` sv `:host:5000`x": [],
    "` sv `:a`b": [],
    "read0 ` sv `:a`b": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("hopen of hsym applied in brackets to a file is a change (#1729)", () => {
  const cases = {
    'hopen hsym[`$"/tmp/f"]': ["opens the file `:/tmp/f with hopen"],
    "hopen hsym[`f]": ["opens the file `:f with hopen"],
    "h:hopen hsym[`f]": ["assigns h", "opens the file `:f with hopen"],
    // Of a process it only connects.
    'hopen hsym[`$"host:5000"]': [],
    "hopen hsym[`$\":host:5000\"]": [],
    // Of a name, it may be either: asked about (#2207).
    "hopen hsym[x]": ["opens a handle the guard cannot read with hopen"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a connection still to the old address of an edited process keeps its old tags (#1443)", () => {
  const open = { host: "prodhost", port: 5000, tags: ["prod"] };
  // Moved: still connected to prodhost, so still guarded.
  for (const saved of [
    { host: "devhost", port: 5000, tags: ["dev"] },
    { host: "prodhost", port: 5001, tags: [] },
    { host: "prodhost", port: 5000, user: "me", tags: ["dev"] },
    { host: "prodhost", port: 5000, tls: true, tags: ["dev"] },
  ]) {
    const tags = openTags(open, saved);
    assert.deepStrictEqual(guardedBy({ tags }, settings()), ["prod"], JSON.stringify(saved));
    assert.ok(saved.tags.every((t) => tags.includes(t)));
  }
  // At the same address, the new tags are its own: untagging unguards it.
  assert.deepStrictEqual(openTags(open, { host: "prodhost", port: 5000, tags: ["dev"] }), ["dev"]);
  assert.deepStrictEqual(openTags({ ...open, tags: ["dev"] }, { host: "prodhost", port: 5000, tags: ["prod"] }), ["prod"]);
});

test("in a lambda, a qsql or table-literal column of a name does not make it a local (#1444)", () => {
  const cases = {
    "{select a:b from t; a+:1}[]": ["assigns a"],
    "{exec a:b from t; a+:1}[]": ["assigns a"],
    "{([] a:1 2); a+:1}[]": ["assigns a"],
    "{t:([] a:1 2); a+:1}[]": ["assigns a"],
    "{([k:1 2] v:3 4); k[0]:5}[]": ["assigns k"],
    // A plain assignment, also in a column's expression, still makes a local.
    "{a:5; a+:1; a}[]": [],
    "{s:([] c:a:1 2); a+:1; a}[]": [],
    "{s:select a:b from t; a:s`a; a+:1}[]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an amend or ! in parentheses applied in brackets is a change (#1445)", () => {
  const cases = {
    "(@)[`.;`a;:;1]": ["amends `. in place"],
    "(.)[`a;();:;1]": ["amends `a in place"],
    "(!)[`t;();0b;`a]": ["updates or deletes from `t in place with !"],
    "(@)[`t;`c;`p#]": ["amends `t in place"],
    // On a value, or a trap, it reads.
    "(@)[t;0;:;1]": [],
    "(.)[f;(1;2);{x}]": [],
    "(@)[f;x;{y}]": [],
    "(!)[t;();0b;`a]": [],
    "(x+1)[0]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an amend in any number of parentheses applied in brackets is a change (#1730)", () => {
  const cases = {
    "((@))[`.;`a;:;1]": ["amends `. in place"],
    "(((.)))[`a;();:;1]": ["amends `a in place"],
    "((!))[`t;();0b;`a]": ["updates or deletes from `t in place with !"],
    // On a value, unbalanced, or not an amend, it reads.
    "((@))[t;0;:;1]": [],
    "(f(@))[`.;`a;:;1]": [],
    "((x))[0]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("value or eval of an amend tree on a variable by name is a change (#1446)", () => {
  const cases = {
    "value(@;`.;`a;:;1)": ["evaluates an amend with value"],
    "value(.;`.;enlist`a;:;1)": ["evaluates an amend with value"],
    "eval(@;enlist`.;enlist`a;:;1)": ["evaluates an amend with eval"],
    "-6!(@;enlist`t;0;:;1)": ["evaluates an amend with -6!"],
    // An index, or an amend of a value, reads.
    "value(@;`t;0)": [],
    "value(@;t;0;:;1)": [],
    "eval(@;`t;0;:;1)": [],
    "value@(`t)": [],
    "value(.;d;enlist`a)": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("value of an amend tree with the head in parentheses or projected is a change (#1727)", () => {
  const cases = {
    "value((@);`a;();:;1)": ["evaluates an amend with value"],
    "value((.);`a;();:;1)": ["evaluates an amend with value"],
    "value(@[;`a;:;2];`.)": ["evaluates an amend with value"],
    "value(.[;();:;5];`a)": ["evaluates an amend with value"],
    "eval((@);enlist`.;enlist`a;:;1)": ["evaluates an amend with eval"],
    // An index, an amend of a value, or a projection not on a name reads.
    "value((@);`t;0)": [],
    "value((@);t;0;:;1)": [],
    "value(@[;0;:;2];t)": [],
    "value(@[;0];`t)": [],
    "value(@[;0;{9}];`b)": ["evaluates an amend with value"],
    "value(@[f;0];`t)": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("xasc, xdesc and xkey projected on the columns, then applied to a table by name, are changes (#1447)", () => {
  const cases = {
    "xasc[`a]`t": ["sorts `t in place with xasc"],
    "xdesc[`a] `t": ["sorts `t in place with xdesc"],
    "xkey[`a]`t": ["keys `t in place with xkey"],
    "xasc[`a][`t]": ["sorts `t in place with xasc"],
    "xasc[`a;`t]": ["sorts `t in place with xasc"],
    // Applied to a table's value, or not applied, it reads.
    "xasc[`a] t": [],
    "xasc[`a]": [],
    "f:xasc[`a]": ["assigns f"],
    "xasc[`a;t]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("xasc projected with a trailing ;, applied with @, or as (`a xasc) on a table by name is a change (#1725)", () => {
  const cases = {
    "xasc[`a;]`t": ["sorts `t in place with xasc"],
    "xasc[`a]@`t": ["sorts `t in place with xasc"],
    "@[xasc[`a];`t]": ["sorts `t in place with xasc"],
    "(`a xasc)`t": ["sorts `t in place with xasc"],
    "(`a xdesc)@`t": ["sorts `t in place with xdesc"],
    "xkey[`a;][`t]": ["keys `t in place with xkey"],
    // On a table's value, or not applied, they read.
    "xasc[`a;]t": [],
    "xasc[`a]@t": [],
    "@[xasc[`a];t]": [],
    "(`a xasc)t": [],
    "(`a xasc)": [],
    "xasc[`a;]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("in k code, a monadic . evaluates as value does (#1448)", () => {
  const cases = {
    'k)."a:1"': ["evaluates a string with k's ."],
    'k).:"a:1"': ["evaluates a string with k's ."],
    "k).(:;`a;1)": ["evaluates an assignment with k's ."],
    'k)x:1;."b:2"': ["assigns x", "evaluates a string with k's ."],
    // Any string, as with value "1+1": the text is not read further.
    'k)."1+1"': ["evaluates a string with k's ."],
    // Dyadic . applies, and q's . on a string is not k's.
    'k)f . ("a";1)': [],
    "k)+/1 2 3": [],
    'f . ("a:1";1)': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a monadic . in parentheses evaluates as value does, in k code and in q (#1728)", () => {
  const cases = {
    'k)(.)"a:1"': ["evaluates a string with k's ."],
    'k)(.:)"a:1"': ["evaluates a string with k's ."],
    '(.)"a:1"': ["evaluates a string with (.)"],
    '(.:)"a:1"': ["evaluates a string with (.)"],
    'x:(.)"a:1"': ["assigns x", "evaluates a string with (.)"],
    // Applied in brackets, or infix, it is dyadic; alone it is not applied.
    "k)(.)[f;1 2]": [],
    "(.)[f;1 2]": [],
    "k)(.)": [],
    "(.)": [],
    'f . ("a:1";1)': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a writer taken out of .q or .Q by juxtaposition is a change (#1449)", () => {
  const cases = {
    "(.q`set)[`a;1]": ["calls .q.set"],
    ".q `upsert": ["calls .q.upsert"],
    "(.Q`dpft)[`:d;.z.d;`sym;`t]": ["calls .Q.dpft"],
    ".q[`set][`b;2]": ["calls .q.set"],
    // What is not a writer reads.
    "(.Q`dd)[`:a;`b]": [],
    "(.q`count) t": [],
    "key .q": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a writer taken out of .q with @ or . enlist is a change (#1726)", () => {
  const cases = {
    "(.q@`set)[`b;2]": ["calls .q.set"],
    "(.q . enlist`set)[`b;2]": ["calls .q.set"],
    ".Q@`dpft": ["calls .Q.dpft"],
    // What is not a writer reads.
    "(.q@`count) 1 2": [],
    "(.q . enlist`count) 1 2": [],
    "(.Q@`dd)[`:a;`b]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an amend or ! through an adverb or a composition is a change (#1771)", () => {
  const cases = {
    "@/[`.;`a;:;9]": ["amends `. in place"],
    "@/[`b;::;1+]": ["amends `b in place"],
    "(@/)[`.;`a;:;9]": ["amends `. in place"],
    "'[::;@][`.;`a;:;9]": ["amends `. in place"],
    "'[::;(@)][`.;`a;:;9]": ["amends `. in place"],
    "'[::;!][`t;();0b;(enlist`a)!enlist 9]": ["updates or deletes from `t in place with !"],
    "'[::;.][`:o.txt;();,;1 2]": ["amends `:o.txt in place"],
    // On a value, an index, or another function, it reads.
    "@/[b;::;1+]": [],
    "'[::;@][t;0]": [],
    "'[::;@][`t;0]": [],
    "'[neg;+][1;2]": [],
    "+/[1 2 3]": [],
    ",/[`a;`b]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("KDB-X use, .h.ht and .Q.L are changes (#1775)", () => {
  const cases = {
    "use`kx.rest": ["calls use"],
    "r:use`kx.rest": ["assigns r", "calls use"],
    ".h.ht`T": ["calls .h.ht"],
    ".Q.L[`:db;();`:.]": ["calls .Q.L"],
    // Their neighbours read.
    ".h.htc[`p;\"x\"]": [],
    ".h.hta[`a;()!()]": [],
    "select users from t": [],
    ".Q.s t": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("? on a symbol atom in parentheses or applied in brackets extends an enumeration (#1773)", () => {
  const cases = {
    "(`sym)?`q": ["extends the enumeration `sym with ?"],
    "((`sym))?`q": ["extends the enumeration `sym with ?"],
    "?[`sym;`q]": ["extends the enumeration `sym with ?"],
    "?[`:db/sym;`q`r]": ["extends the enumeration `:db/sym with ?"],
    // A list, a value, or a functional select or exec reads.
    "(`a`b)?`b": [],
    "(s)?`q": [],
    "?[`a`b;`b]": [],
    "?[s;`q]": [],
    "?[`t;();0b;()]": [],
    "?[`t;();();`a]": [],
    "?[1b;`a;`b]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a name in parentheses or a nested destructuring list assigns (#1772)", () => {
  const cases = {
    "(a):9": ["assigns a"],
    "((a)):9": ["assigns a"],
    "((a;c);d):((1;2);3)": ["assigns a", "assigns c", "assigns d"],
    "(a;(c;d)):(1;(2;3))": ["assigns a", "assigns c", "assigns d"],
    "(.ns.v;a):1 2": ["assigns .ns.v", "assigns a"],
    "{((a;c);d)::((1;2);3)}[]": ["assigns a", "assigns c", "assigns d"],
    // A local in a lambda, a list that is not all names, or a comparison reads.
    "{((a;c);d):((1;2);3); a+c}[]": [],
    "{(a):9}[]": [],
    "((a;1);d)": [],
    "(a)=9": [],
    "(a;b)~1 2": [],
    "f[(a);9]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("reval or -24! of an assignment tree is a change (#1774)", () => {
  const cases = {
    "reval(:;`a;9)": ["evaluates an assignment with reval"],
    "reval(+:;`a;1)": ["evaluates an assignment with reval"],
    ".q.reval(:;`a;9)": ["evaluates an assignment with .q.reval"],
    "-24!(:;`a;9)": ["evaluates an assignment with -24!"],
    // A tree that only reads, reads.
    "reval(+;1;2)": [],
    "reval(count;`t)": [],
    "-24!(+;1;2)": [],
    "reval x": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a string literal an evaluator runs is read as the code it is (#1776)", () => {
  const cases = {
    'value"select from t"': [],
    'get"count t"': [],
    'eval parse"select from t"': [],
    '@[value;"count t";{x}]': [],
    'value each ("count t";"count b")': [],
    'value"\\\\v"': [],
    '-6!parse"count t"': [],
    'value -5!"count t"': [],
    // One that writes, is built, or passes through another function is a change.
    'value"select from t";value"a:9"': ["evaluates a string with value"],
    'value each ("count t";"a:9")': ["evaluates a string with value"],
    'value"`b set 7"': ["evaluates a string with value"],
    'value"\\\\l s.q"': ["evaluates a string with value"],
    'eval parse"update a:9 from `t"': ["evaluates a parse tree with eval"],
    'value "a",":9"': ["evaluates a string with value"],
    'value raze("a";":9")': ["evaluates a string with value"],
    'value "count t"[0]': ["evaluates a string with value"],
    "eval parse x": ["evaluates a parse tree with eval"],
    // The identity is not an assignment.
    "eval(::)": [],
    "-6!(::)": [],
    // k code is not read: its . evaluates k.
    'k)."1+1"': ["evaluates a string with k's ."],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("value or get passed as a value evaluates the strings around it (#1766)", () => {
  const cases = {
    'value/["a:9"]': ["evaluates a string with value"],
    'get\\["a:9"]': ["evaluates a string with get"],
    '(value@)"a:9"': ["evaluates a string with value"],
    '((get)@)"a:9"': ["evaluates a string with get"],
    "'[value;::]\"a:9\"": ["evaluates a string with value"],
    "'[::;(get@)]\"a:9\"": ["evaluates a string with get"],
    '@[(value);"a:9";{x}]': ["evaluates a string with value"],
    '((value).)enlist"a:9"': ["evaluates a string with value"],
    '(get@)\'[enlist "a:9"]': ["evaluates a string with get"],
    '.Q.trp[(value);"a:9";{x}]': ["evaluates a string with value"],
    // On a read, a value, or a string beside it in another expression, it reads.
    'value/["count t"]': [],
    "'[value;::]`t": [],
    '@[(value);"count t";{x}]': [],
    "(value@)x": [],
    'f:{value/[x]};"a:b"': ["assigns f"],
    'f:{(value@)x}': ["assigns f"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("value or eval of a list headed by what changes the process is a change (#1767)", () => {
  const cases = {
    'value(value;"a:9")': ["evaluates a call of value with value"],
    'eval(get;"a:9")': ["evaluates a call of get with eval"],
    "value(hopen;`:g.txt)": ["evaluates a call of hopen with value"],
    'value((value);"a:9")': ["evaluates a call of (value) with value"],
    'value(.q.get;"a:9")': ["evaluates a call of .q.get with value"],
    "value(set;`b;7)": ["evaluates a call of set with value"],
    "value(?;`sym;`q)": ["evaluates a call of ? with value"],
    "eval(?;enlist`sym;enlist`q)": ["evaluates a call of ? with eval"],
    'eval(eval;(parse"a:9"))': ["evaluates a call of eval with eval"],
    // One that only reads, reads.
    'value(value;"count t")': [],
    "value(hopen;`::5000)": [],
    "value(count;`t)": [],
    "eval(count;`t)": [],
    "value(+;1;2)": [],
    "eval(?;`s;enlist`q)": [],
    'value("count t";"count b")': [],
    "value({x+1};2)": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a list sent to handle 0 is evaluated as value evaluates it (#1768)", () => {
  const cases = {
    '0(value;"a:9")': ["evaluates a call of value on handle 0"],
    "0(@;`b;0;:;9)": ["evaluates an amend on handle 0"],
    "0(!;`t;();0b;(enlist`a)!enlist 9)": ["evaluates a functional update or delete on handle 0"],
    "0(:;`a;9)": ["evaluates an assignment on handle 0"],
    "neg[0](:;`a;9)": ["evaluates an assignment on handle 0"],
    '0((get@);"a:9")': ["evaluates a call of (get@) on handle 0"],
    // One that reads, or 0 as a number, reads.
    "0(count;`t)": [],
    '0"count t"': [],
    "@[`b;0]": [],
    "b[0]": [],
    "0 1 2": [],
    "(0;1)": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an evaluator, hopen or xkey taken out of .q or named by its symbol is a change (#1764)", () => {
  const cases = {
    '.q[`value]"a:9"': ["calls .q.value"],
    '(.q`get)"a:9"': ["calls .q.get"],
    '(`.q.value)"a:9"': ["calls .q.value"],
    ".q[`xkey][`a;`t]": ["calls .q.xkey"],
    "(`.q.xkey)[`a;`t]": ["calls .q.xkey"],
    "(.q@`hopen)`:g.txt": ["calls .q.hopen"],
    '(get`.q.get)["a:9"]': ["calls .q.get"],
    // What is not one of them, or the name applied directly, reads.
    ".q[`count]`t": [],
    "(`.q.count)`t": [],
    ".q.value `t": [],
    "`a .q.xkey t": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a function picked from .q by any index is a change (#1765)", () => {
  const cases = {
    "(.q . enlist`set)[`b;7]": ["calls .q.set"],
    "(.q[enlist`set]0)[`b;7]": ["calls .q.set"],
    "((get`.q)`set)[`b;7]": ["calls .q.set"],
    "((value`.q)`hdel)`:f.txt": ["calls .q.hdel"],
    '(.q`$"set")[`b;7]': ["calls .q.set"],
    "(.q`value`get)0": ["calls .q.value"],
    "(.Q`$\"dpft\")[`:d;.z.d;`sym;`t]": ["calls .Q.dpft"],
    // What is not one of them reads.
    "(.q[enlist`count]0)`t": [],
    "((get`.q)`count)`t": [],
    '(.q`$"count") 1 2': [],
    "(.q`count`sum)0": [],
    "key .q; `set": [],
    "count get`.q": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("hopen applied with @, ., ', each, in parentheses or a trap opens the file (#1769)", () => {
  const cases = {
    "hopen@`:g.txt": ["opens a file with hopen"],
    "(hopen)`:g.txt": ["opens a file with hopen"],
    "hopen . enlist`:g.txt": ["opens a file with hopen"],
    "hopen'[enlist`:g.txt]": ["opens a file with hopen"],
    "hopen each enlist`:g.txt": ["opens a file with hopen"],
    "@[hopen;`:g.txt;{x}]": ["opens a file with hopen"],
    ".Q.trp[(hopen@);`:g.txt;{x}]": ["opens a file with hopen"],
    "hopen -1!`g.txt": ["opens a file with hopen"],
    "hopen .q.hsym`g.txt": ["opens a file with hopen"],
    "'[::;hopen]`:g.txt": ["opens a file with hopen"],
    "0((hopen);`:g.txt)": ["evaluates a call of (hopen) on handle 0"],
    // Of a process, or of a value, it connects.
    "hopen@`:host:5000": [],
    "@[hopen;`::5000;{x}]": [],
    "hopen each (`:a:5000;`:b:5001)": [],
    "hopen -1!`host:5000": [],
    "@[hopen;h;{x}]": [],
    "hopen 5000": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("xkey or xdesc applied in parentheses, with . or an adverb, or composed keys or sorts in place (#1770)", () => {
  const cases = {
    "(xkey)[`a;`t]": ["keys a table in place with xkey"],
    "(xkey)[`a]@`t": ["keys a table in place with xkey"],
    ".[xkey;(`a;`t)]": ["keys a table in place with xkey"],
    "xkey/[`a;`t]": ["keys a table in place with xkey"],
    ".q.xkey . (`a;`t)": ["keys a table in place with .q.xkey"],
    "'[::;xdesc][`a;`t]": ["sorts a table in place with xdesc"],
    "`a xdesc/: enlist `t": ["sorts a table in place with xdesc"],
    "(enlist `a) xkey\\: `t": ["keys a table in place with xkey"],
    "xdesc'[enlist `a;enlist `t]": ["sorts a table in place with xdesc"],
    // On a value, the columns alone, or another expression's symbol, it reads.
    ".[xkey;(`a;t)]": [],
    "(xkey)[`a]t": [],
    "`a`b xasc/: (t;u)": [],
    "f:(xdesc)[`a]; `t": ["assigns f"],
    "`a xdesc select from t where s=`x": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("0: and 1: to any handle but a parse or prepare format write a file: 1: takes a plain symbol (#2032)", () => {
  const cases = {
    "`a 1: 0x00": ["writes the file `a with 1:"],
    "1:[`b1;0x00]": ["writes the file `b1 with 1:"],
    ".[1:;(`b2;0x00)]": ["writes the file `b2 with 1:"],
    "(`b6) 1: 0x01": ["writes a file with 1:"],
    '`b0 0: enlist "x"': ["writes the file `b0 with 0:"],
    // A name, an index or an argument not written may hold a handle.
    "f 1: 0x00": ["writes a file with 1:"],
    "x[0] 0: y": ["writes a file with 0:"],
    "0:/[`a;y]": ["writes a file with 0:"],
    ".[1:;args]": ["writes a file with 1:"],
    // A format reads: a string, or a list headed by one.
    '"," 0: t': [],
    '"S=;" 0: "a=1;b=2"': [],
    '(1#"x";1) 1: `:a': [],
    '(enlist ",") 0: t': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("text q values whole is read as value reads it: a / line is a comment to its end, not a block (#2033)", () => {
  const { valued } = require("../out/guard.js");
  assert.deepStrictEqual(writes([valued("(1;\n/\nd6:9)")]), ["assigns d6"]);
  assert.deepStrictEqual(writes([valued("1\n/ note\nd1:9")]), ["assigns d1"]);
  assert.deepStrictEqual(writes([valued("count t\n/\ncount u")]), []);
  assert.deepStrictEqual(writes([valued("\\l f.q")]), ["runs the system command \\l"]);
  // A script's text keeps a script's rules: there the / opens a block.
  assert.deepStrictEqual(writes("(1;\n/\nd6:9)"), []);
  assert.deepStrictEqual(writes(["count t", valued("(1;\n/\nd6:9)")]), ["assigns d6"]);
});

test("a language prefix, repeated or nested, hides neither a system command nor k's . (#2034)", () => {
  const cases = {
    "k)\\l ld.q": ["runs the system command \\l"],
    "k)\\cd sub": ["runs the system command \\cd"],
    "q)\\cd sub": ["runs the system command \\cd"],
    "q)q)\\cd sub": ["runs the system command \\cd"],
    "q)k)\\t 500": ["sets the timer with \\t"],
    'q)k)."i5:1"': ["evaluates a string with k's ."],
    'k)k)."i9:1"': ["evaluates a string with k's ."],
    // A setting read, or q code, after the prefix still reads.
    "k)\\c": [],
    "q)count t": [],
    "q)\\t count t": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a lambda applied where it is written changes what its arguments name: {.[x;();:;1]}`a (#2035)", () => {
  const cases = {
    '{value x}"s1:1"': ["evaluates a string with value"],
    '{value x}["s1:1"]': ["evaluates a string with value"],
    '{value y}[0;"s6:1"]': ["evaluates a string with value"],
    '{value x}@"s7:1"': ["evaluates a string with value"],
    '{value x} each enlist "s2:1"': ["evaluates a string with value"],
    "{eval x}(:;`s3;1)": ["evaluates an assignment with eval"],
    "{.[x;();:;1]}`u1": ["amends `u1 in place"],
    "({@[x;();:;1]})`u2": ["amends `u2 in place"],
    "{update a:9 from x}`t": ["updates `t in place"],
    "{x 1: 0x00}`:u5": ["writes a file with 1:"],
    "{hclose hopen x}`:u4": ["opens the file `:u4 with hopen", "calls hclose"],
    "{.[x;();:;1]} each `v2`v3": ["amends `v2 in place", "amends `v3 in place"],
    "@[{.[x;();:;1]};`a;h]": ["amends `a in place"],
    // A name may hold a global's symbol, and an argument not written may be one.
    "{.[x;();:;1]} v": ["applies a lambda that may change the process through what it is given"],
    // `enlist x` is read as its one item (#2201).
    "{.[x;();:;1]} . enlist `a": ["amends `a in place"],
    // Applied to what it only reads, defined, or left as a value, it reads.
    '{value x}"count t"': [],
    "{x+1} each 1 2 3": [],
    "{select from x where a>1}`t": [],
    "{x} v": [],
    "{value x}": [],
    "{x 1}{value x}": [],
    "({value x};1)": [],
    "f:{value x}": ["assigns f"],
    "{@[x;0;3_]} read0 `:f": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("? passed as a value, in parentheses, through an adverb or to . or @, extends an enumeration (#2036)", () => {
  const cases = {
    "(?)[`sym;`x1]": ["extends the enumeration `sym with ?"],
    ".[?;(`sym;`x2)]": ["extends the enumeration `sym with ?"],
    "?/[`sym;`x3]": ["extends the enumeration `sym with ?"],
    "?'[`sym`sym;`x4`x5]": ["extends the enumeration `sym with ?"],
    ".[(?);(`sym;`x6)]": ["extends the enumeration `sym with ?"],
    "(?) . (`sym;`x7)": ["extends the enumeration `sym with ?"],
    // On a list, or a functional select, it finds or selects.
    "(?)[`a`b;`b]": [],
    "(?)[1 2 3;2]": [],
    ".[?;(t;();0b;())]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a writer named by a symbol cast from a string is the writer: (`$\".q.set\") . (`a;1) (#2037)", () => {
  const cases = {
    '(`$".q.set") . (`zz1;1)': ["calls .q.set"],
    '(`$".q.value") "p8:1"': ["calls .q.value"],
    '`$ ".q.set" . (`a;1)': ["calls .q.set"],
    '(get `$".q.upsert")[`t;()]': ["calls .q.upsert"],
    '.q`$"set"': ["calls .q.set"],
    // A cast to another name reads.
    '`$"abc"': [],
    '(`$".q.count") 1 2': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an amend projected on all but its target, in parentheses or applied some way, amends the target (#2038)", () => {
  const cases = {
    "(.[;();:;1]) `q8": ["amends `q8 in place"],
    "(@[;();:;1]) `u8": ["amends `u8 in place"],
    "(.[;();:;1])[`u9]": ["amends `u9 in place"],
    "((.[;();:;1])) `v1": ["amends `v1 in place"],
    "(.[;();:;1]) each `v2`v3": ["amends `v2 in place"],
    "(@[;`a;:;1]) `.": ["amends `. in place"],
    "(.[;();:;1])@`w1": ["amends `w1 in place"],
    "(.[;();:;1]) . enlist `w2": ["amends `w2 in place"],
    ".[;();:;1]/:[`w3]": ["amends `w3 in place"],
    // On a value it is a value.
    "(.[;();:;1]) t": [],
    "(@[;0;+;1]) 1 2": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a gateway query the guard cannot read as strings, where the call is, is taken for a change (#2039)", () => {
  const cannot = (name = ".gw.syncexec") => `runs a query the guard cannot read through ${name}`;
  const cases = {
    ".gw.syncexec[(@;`.;`a;:;1);`rdb]": [cannot()],
    ".gw.syncexec[(:;`a;1);`rdb]": [cannot()],
    ".gw.syncexec[;`rdb] \"a:1\"": [cannot()],
    '(.gw.syncexec)["a:1";`rdb]': [cannot()],
    '`.gw.syncexec . ("a:1";`rdb)': ["assigns a through .gw.syncexec"],
    '.gw.syncexec["a",":1";`rdb]': [cannot()],
    ".gw.syncexec[q;`rdb]": [cannot()],
    '.gw.asyncexec[(`.q.set;`a;1);`rdb]': [cannot(".gw.asyncexec"), "calls .q.set"],
    // A string, strings, the extension's own wrap of them, or the name alone read.
    '.gw.syncexec["select from t";`rdb]': [],
    '.gw.syncexec[("count t";"count u");`rdb]': [],
    '.gw.syncexec[({last value each x};("count t";"count u"));enlist `rdb]': [],
    '.gw.syncexecj["select from t";`rdb`hdb;raze]': [],
    ".gw.syncexec": [],
    "`.gw.syncexec": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a guard tag with a blank in it is read as process tags are, a tag for each word (#2040)", () => {
  const { readKxServers } = require("../out/importother.js");
  const blank = settings({ "processes.readOnlyGuard.tags": ["live desk", "UAT,Desk"] });
  assert.deepStrictEqual(blank.tags, ["live", "desk", "uat"]);
  // A KX connection labelled Live Desk is guarded, and a process tagged a word of it.
  const kx = readKxServers({ a: { serverAlias: "a", serverName: "h", serverPort: "5000" } }, [{ labelName: "Live Desk", connections: ["a"] }], blank.tags);
  assert.deepStrictEqual(guardedBy(kx.processes[0], blank), ["live", "desk"]);
  assert.deepStrictEqual(guardedBy({ tags: ["live"] }, blank), ["live"]);
  // A process tag saved with a blank is read by its words too.
  assert.deepStrictEqual(guardedBy({ tags: ["Live Desk"] }, settings({ "processes.readOnlyGuard.tags": ["desk"] })), ["Live Desk"]);
  assert.deepStrictEqual(guardedBy({ tags: ["dev"] }, blank), []);
});

test("! passed as a value with -11 or -19 replays a log or writes a compressed file (#2041)", () => {
  const cases = {
    "(!)[-11;`:lg]": ["replays a log with -11!"],
    ".[!;(-11;`:lg)]": ["replays a log with -11!"],
    "!/[-11;`:lg]": ["replays a log with -11!"],
    ".[!;(-19;(`:lg;`:lgz;17;2;6))]": ["writes a compressed file with -19!"],
    "(!)[-6;(:;`a;1)]": ["evaluates an assignment with -6!"],
    // Counting a log, a dictionary, or another internal function reads.
    "(!)[-11;(-1;`:lg)]": [],
    "(!)[`a`b;1 2]": [],
    "(!) . (`a`b;1 2)": [],
    '(!)[-4;"x"]': [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("\\t and \\ts nested deep are read in a loop, not one call each", () => {
  assert.deepStrictEqual(writes(`${"\\ts ".repeat(2000)}a:1`), ["assigns a"]);
  assert.deepStrictEqual(writes(`${"\\t ".repeat(2000)}count t`), []);
});

const TOO_MUCH = "is too long or too deeply nested for the guard to read";

test("the answer is the code's alone, whatever was read before it (#2190)", () => {
  // Read-only, with more lambdas applied than one statement may have read
  // again: asked about the first time and every time after, cold or warm.
  const many = Array.from({ length: 3000 }, (_, i) => `{x+${i}} v${i}`).join(";");
  const first = writes(many);
  assert.ok(first.includes(TOO_MUCH), JSON.stringify(first));
  assert.deepStrictEqual(writes(many), first);
  writes("{x+1} v");
  assert.deepStrictEqual(writes(many), first);
  // Under the bound, it reads, each time.
  const some = Array.from({ length: 800 }, (_, i) => `{x+${i}} v${i}`).join(";");
  assert.deepStrictEqual(writes(some), []);
  assert.deepStrictEqual(writes(some), []);
});

test("code too deep or too long to read is asked about, quickly, and never throws (#2210, #2211)", () => {
  const timed = (code) => {
    const started = process.hrtime.bigint();
    const found = writes(code);
    return [found, Number(process.hrtime.bigint() - started) / 1e6];
  };
  for (const code of [
    `${"{x}@".repeat(1000)}\`a`,
    `${"{x}[".repeat(600)}\`a${"]".repeat(600)}`,
    `${"{.[x;();:;1]}[".repeat(1000)}v${"]".repeat(1000)}`,
    `${"{x} each ".repeat(1000)}\`a`,
    `${"@[".repeat(3000)}t${";0;neg]".repeat(3000)}`,
  ]) {
    const [found, ms] = timed(code);
    assert.ok(found.includes(TOO_MUCH), `${code.slice(0, 20)}: ${JSON.stringify(found)}`);
    // Well under the 100 ms a send may wait; generous for a loaded machine.
    assert.ok(ms < 1000, `${code.slice(0, 20)}: ${ms} ms`);
  }
  // Deep parentheses are read without recursion, and a list of names in
  // them still assigns each.
  assert.deepStrictEqual(writes(`${"(".repeat(8000)}1${")".repeat(8000)}`), []);
  assert.deepStrictEqual(writes("((a;(b;c));d):x"), ["assigns a", "assigns b", "assigns c", "assigns d"]);
});

test("code in another language than q and k is read as SQL, or asked about (#2197, #2209)", () => {
  const cases = {
    // KDB-X SQL, read as the SQL tab's guard reads it: a write word in any case.
    "s)DROP TABLE t": ["runs SQL that changes data (DROP)"],
    "s)INSERT INTO t VALUES(9,'q')": ["runs SQL that changes data (INSERT)"],
    "s)CREATE TABLE zz (a int)": ["runs SQL that changes data (CREATE)"],
    "k)s)Insert Into t Values(9,'q')": ["runs SQL that changes data (INSERT)"],
    "s) select qt('a:1')": ["runs SQL that changes data (QT())"],
    "\\t s)delete from t": ["runs SQL that changes data (DELETE)"],
    "s)\\l f.q": ["runs the system command \\l through SQL"],
    // A prefix after it is read again: KDB-X runs this as q.
    "k)s)s)q)b[0]:77": ["assigns b"],
    "s)SELECT * FROM t": [],
    "q)s)select a from t where b=1": [],
    // Python is not read: a `p)` line, and embedPy's or PyKX's evaluators.
    'p)import os; os.remove("f")': ["runs Python the guard cannot read"],
    '.p.e "import os"': ["runs Python with .p.e"],
    '.p.qeval"1+1"': ["runs Python with .p.qeval"],
    '.pykx.pyexec"x=1"': ["runs Python with .pykx.pyexec"],
    // Nor any other language.
    "r)print(1)": ["runs r) code the guard cannot read"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a target that may be a symbol it cannot read - computed, a handle made, a local's - counts as by name (#2198-#2202, #2207)", () => {
  const asks = [
    // #2198: computed.
    "@[first`b;0;+;1]", '.[`$"a","";();:;77]', ".[`$string`a;();:;77]", ".[{`a}[];();:;77]", "update a:77 from first`t", "delete from first`t",
    "![first`t;();0b;(enlist`a)!enlist 77]", "`a xdesc first`t", "() xkey `$string`kt", "(first`sym)?`zz", "((`sym;`zz)0)?`zz", ".[`a`zz 0;();:;77]",
    "@[(`d;`zz)0;`a;neg]", ".[(`k!enlist`a)`k;();:;77]", ".[`a`zz inter`a;();:;77]", ".[1#`a;();:;77]", ".[last`zz`a;();:;77]",
    // #2199: a file's handle made.
    ".[hsym`o.txt;();:;77]", ".[-1!`o.txt;();:;77]", ".[.Q.dd[`:.;`o.txt];();:;77]", ".[` sv`:.`o.txt;();:;77]", '.[hsym`$"o.txt";();:;77]',
    // #2200: held by a local, or given to a local lambda.
    "{s:`a;.[s;();:;77]}[]", "{s:`t;update a:77 from s}[]", "{s:`sym;?[s;`zz]}[]", "{s:`kt;() xkey s}[]", '{f:{.[x;();neg]};f `$reverse"a"}[]',
    // #2201: each item of `enlist x`.
    "{.[x;();+;1]} each enlist `a", "{.[x;();+;1]}'[enlist `a]", "{.[x;();+;1]} peach enlist `a", "(.[;();+;1]) each enlist `a", ".[;();+;1] each enlist `a",
    "@[;0;+;1] each enlist `b", "{update a:77 from x} each enlist `t",
    // #2202: `?[` on a symbol in parentheses, as a parameter is given.
    "?[(`sym);`zz]", "{?[x;`zz]}`sym", "{?[x;`zz]}[`sym]", "{[s]?[s;`zz]}[`sym]", "@[{?[x;`zz]};`sym;::]", ".[{?[x;`zz]};enlist `sym;::]",
    // #2189, #2196: the items `.` applies to, a list of symbols, `enlist x`.
    "(?) . `sym`x", ".[?;`sym`x]", '{value x} . enlist "a:1"',
    // #2207: hopen of a handle made some way it cannot read.
    "hopen hsym(`o.txt)", "hopen hsym first`o.txt", "hopen hsym`$string`o.txt", 'hopen hsym`$raze"o.txt"', "hopen hsym{`o.txt}[]", "hopen -1!(`o.txt)",
    'hopen@`$":",string`o.txt', "@[hopen;hsym(`o.txt);::]", "(hopen)hsym(`o.txt)", "hopen each enlist hsym(`o.txt)", "{hopen x}hsym(`o.txt)", ".[hopen;enlist hsym(`o.txt);::]",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes("@[first`b;0;+;1]"), ["amends what first`b names in place"]);
  assert.deepStrictEqual(writes("update a:77 from first`t"), ["updates what first`t names in place"]);
  assert.deepStrictEqual(writes("{s:`a;.[s;();:;77]}[]"), ["amends what s names in place"]);
  assert.deepStrictEqual(writes("?[(`sym);`zz]"), ["extends the enumeration `sym with ?"]);
  assert.deepStrictEqual(writes("hopen hsym first`o.txt"), ["opens a handle the guard cannot read with hopen"]);
  // A value stays a value: a name, a list or dictionary of symbols, a
  // symbol indexed, a table sorted or selected, a lambda trapped, and a
  // process's handle.
  const reads = [
    "@[t;`a;neg]", "@[`a`b;0;:;`c]", "@[(`a;`b);0;:;1]", "@[`a`b!1 2;`a;+;1]", "@[(`t)[0];`a;:;1]", "@[(`d)`a;0;neg]", "update a:1 from `a xasc t",
    "update a:1 from select from t", "delete from 0!kt", "@[{x+1};1;{x}]", "@[value;\"count t\";{x}]", "{s:select from t; update a:1 from s}[]",
    "{s:`a; select from t where b=s}[]", "{f:{x+1}; f 2}[]", "(`p`q)?`q", "(exec b from t)?`x", "hopen (`:localhost:5000;1000)", "hopen hsym`$\"host:5000\"",
    "`a xkey 0!kt", "{x[`a]} each enlist d",
  ];
  for (const code of reads) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("a string made without a string written is evaluated as one that writes, by value and by handle 0 (#2203, #2204)", () => {
  const cases = {
    "value string`a:77": ["evaluates a string with value"],
    'value string`$".ns.v:77"': ["evaluates a string with value"],
    "get`char$97 58 55 55": ["evaluates a string with get"],
    "{value x}string`a:77": ["evaluates a string with value"],
    "@[value;string`a:77;::]": ["evaluates a string with value"],
    ".Q.trp[value;string`a:77;::]": ["evaluates a string with value"],
    'value each enlist string`$"a:77"': ["evaluates a string with value"],
    "k).$`a:77": ["evaluates a string with k's ."],
    "value .Q.s1 x": ["evaluates a string with value"],
    'value "c"$0x613a31': ["evaluates a string with value"],
    // Handle 0 given what a function returns.
    '0 raze("a:";"77")': ["evaluates a string on handle 0"],
    '0 {x}"a:77"': ["evaluates a string on handle 0"],
    "0 string`a:77": ["evaluates a string on handle 0"],
    '0 ssr["a+=1";"=";":"]': ["evaluates a string on handle 0"],
    '0 trim" b[0]:77 "': ["evaluates a string on handle 0"],
    '(0)raze("a:";"77")': ["evaluates a string on handle 0"],
    'neg[0]raze("a:";"77")': ["evaluates a string on handle 0"],
    // A symbol cast, an enumeration, a list holding a cast,
    // and a keyword after 0 are not strings made.
    "get`$(),nm": [],
    "value`$\"t\"": [],
    "value`sym$`a": [],
    "eval(!;`t;();0b;`symbol$())": [],
    '0 sublist "abc"': [],
    "0 xbar 1 2 3": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a list headed by a lambda is the lambda applied to the rest: by value, eval, . and a gateway (#2186, #2195)", () => {
  const cases = {
    "value({.[x;();:;1]};`a)": ["evaluates a call of {.[x;();:;1]} with value"],
    "eval({.[x;();:;1]};`a)": ["evaluates a call of {.[x;();:;1]} with eval"],
    ".({.[x;();:;1]};`a)": ["evaluates a call of {.[x;();:;1]} with ."],
    '.gw.syncexec[({value raze x};("a";":1"));`rdb]': ["runs a query the guard cannot read through .gw.syncexec"],
    '.gw.syncexec[({value x,y};"a";":1");`rdb]': ["runs a query the guard cannot read through .gw.syncexec"],
    // A lambda that only reads, on what only reads, still reads.
    "value({x+1};2)": [],
    '.gw.syncexec[({last value each x};("count t";"count u"));`rdb]': [],
    // One that evaluates a string it builds asks, as it does sent alone.
    '.gw.syncexec[({value raze x};("count";" t"));`rdb]': ["runs a query the guard cannot read through .gw.syncexec"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an operator projected and applied later, and a gateway given to . or @, are read as the calls they make (#2187, #2188)", () => {
  const cases = {
    "(?)[`sym] `x": ["extends the enumeration `sym with ?"],
    "(?)[`sym;] `x": ["extends the enumeration `sym with ?"],
    "(?)[`sym]@`x": ["extends the enumeration `sym with ?"],
    "(!)[-11] `:log": ["replays a log with -11!"],
    "(!)[-11;] `:log": ["replays a log with -11!"],
    '.[.gw.syncexec;("a:1";`rdb)]': ["assigns a through .gw.syncexec", "runs a query the guard cannot read through .gw.syncexec"],
    '.[`.gw.syncexec;("a:1";`rdb)]': ["assigns a through .gw.syncexec", "runs a query the guard cannot read through .gw.syncexec"],
    "f[.gw.syncexec]": ["runs a query the guard cannot read through .gw.syncexec"],
    // Projected on what only finds, or named alone, they read.
    "(?)[`a`b] `b": [],
    "(!)[-8] t": [],
    ".gw.syncexec": [],
    "g:.gw.syncexec": ["assigns g"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("an internal function's number with a type or computed is read as the number it is (#2208)", () => {
  const cases = {
    "-11j!`:tp.log": ["replays a log with -11!"],
    "(-11j)!`:tp.log": ["replays a log with -11!"],
    "(neg 11)!`:tp.log": ["replays a log with -11!"],
    "(0-11)!`:tp.log": ["replays a log with -11!"],
    "neg[19]!(`:a;`:b;17;2;6)": ["writes a compressed file with -19!"],
    "-6j!(:;`a;77)": ["evaluates an assignment with -6!"],
    "(neg 6)!(:;`a;77)": ["evaluates an assignment with -6!"],
    // One it cannot work out may be any: asked about.
    "(neg x)!y": ["calls an internal function the guard cannot read with !"],
    // What only reads stays a read: -8!, a count of a log, a dictionary.
    "(neg 8)!t": [],
    "-8j!t": [],
    "(neg 11)!(-2;`:tp.log)": [],
    "(til 3)!`a`b`c": [],
    "(1+2)!x": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("a writer got with parse or -5!, or picked from .q by what the guard cannot read, is called (#2205, #2206)", () => {
  const asks = [
    '(parse"set")[`a;77]', '(parse("set")) . (`a;77)', '(-5!"set")[`a] 77', '{parse x}"set"', '(parse"upsert")[`t;(9;`q)]', '(parse"insert")[`t;(9;`q)]',
    '(parse"xdesc")[`a;`t]', '(parse"hopen")`:o.txt', '(-5!"hopen")`:o.txt', '(parse"value")"a:77"', '(parse"system")"l f.q"', '(parse".")[`a;();:;77]',
    '(parse"-11!")', "(parse x)[`a;77]",
    '.q[`$"se","t"][`a;77]', '.q[`$reverse"tes"][`a] 77', '(.q@`$"se","t")[`a;77]', '((get`.q)`$"se","t")[`a;77]', '(.q`$"xk","ey")[`b;`t]',
    "(.q (key .q) 71)[`a;77]", "((value .q) 71)[`a;77]", '((value .q) 68)"a:77"', '((value .q) 88)"l f.q"', "((value .q) 104)[`a;`t]",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes('(parse"set")[`a;77]'), ["gets set with parse"]);
  assert.deepStrictEqual(writes("((value .q) 71)[`a;77]"), ["calls a function picked from .q by what the guard cannot read"]);
  // Parse of a query, and .q indexed by a read-only builtin's name, read.
  for (const code of ['parse"select from t"', "-5!\"count t\"", ".q`count", ".q[`count]", "key .q", "count .q", '(.q`$"count")t']) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("a string made in an evaluator's own brackets, or cast after handle 0, is evaluated as one that writes (#2203, #2204)", () => {
  const cases = {
    "value[`char$97 58 55 55]": ["evaluates a string with value"],
    "value/[`char$97 58 55 55]": ["evaluates a string with value"],
    "value'[enlist string`$\".ns.v:77\"]": ["evaluates a string with value"],
    "{[p;q]value[`char$97 58 55 55]}[0][1]": ["evaluates a string with value"],
    "0 `char$97 58 55 55": ["evaluates a string on handle 0"],
    "(0)`char$97 58 55 55": ["evaluates a string on handle 0"],
    "neg[0]`char$97 58 55 55": ["evaluates a string on handle 0"],
    "value[`t]": [],
    "0 `a": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test(".h.val, q's own alias of value, evaluates a string as value does (#2273)", () => {
  const cases = {
    '.h.val"a:77"': ["evaluates a string with .h.val"],
    '.h.val "count t"': [],
    "(.h.val)\"a:77\"": ["evaluates a string with .h.val"],
    "@[.h.val;\"a:77\";::]": ["evaluates a string with .h.val"],
    ".h.val(:;`a;77)": ["evaluates an assignment with .h.val"],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
});

test("the debugger's breakpoints patch a function in place: .Q.bs and what it calls, and -104!, are writers (#2276)", () => {
  const asks = [
    ".Q.bs[upd;1]", ".Q.bs[.ns.f;1]", ".Q.bc[g;1;::]", ".Q.bd[g;1]", ".Q.bu[g;1]", ".Q.bp[g;1;0xff]", ".Q.Ls(g;enlist 1;enlist 0xff)",
    "-104!(g;enlist 1;enlist 0xff)", "(-104)!(g;1;0xff)", ".Q[`bs][g;1]", "(.Q`bs)[g;1]", "{.Q.bs[x;1]} g",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes(".Q.bs[upd;1]"), ["calls .Q.bs"]);
  assert.deepStrictEqual(writes("-104!(g;1;0xff)"), ["patches a function's code with -104!"]);
  // Its table of breakpoints, read, is a read.
  assert.deepStrictEqual(writes(".Q.BP"), []);
});

test("-36! loads an encryption master key, which reval does not survive: it is asked about (#2630)", () => {
  for (const code of ["first -36!(`:k;\"p\")", "-36!(`:f;\"pwd\")", "(-36)!(`:f;\"pwd\")", "{-36!x}(`:f;\"p\")"]) {
    assert.deepStrictEqual(writes(code), ["loads an encryption master key with -36!"], code);
  }
});

test("a writer picked out of .h by any index is called, as out of .q and .Q (#2272)", () => {
  const asks = [".h[`ht]`g", "(.h`ht)`g", "(.h@`ht)`g", "(get`.h)[`ht]`g", "(value`.h)`ht", ".h[`$\"ht\"]`g", "{.h[x]}[`ht]`g", ".h[`val]\"a:77\"", "(.h . enlist`ht)`g", ".h[`$\"h\",\"t\"]`g"];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes(".h[`ht]`g"), ["calls .h.ht"]);
  // Its readers, picked, read.
  for (const code of [".h[`tx][`csv;t]", "(.h`hb)[\"a\";\"b\"]", ".h.tx[`csv;t]", "key .h", "(get`.h)`br"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("k's monadic ~ (hdel), < (hopen) and > (hclose) are read as those, on a file or a handle (#2275)", () => {
  const asks = [
    "k)~`:g.txt", "k)<`:o.txt", "k)>.z.w", "k)(~)`:g.txt", "k)~:`:g.txt", "k){~x}`:g.txt", "k)~-1!`g.txt", "k)<`$\":o.txt\"", "k){<x}`:o.txt",
    "k)>(<`:o.txt)", "k)> 3", "k)a:1;~`:g.txt", "q)k)<`:o.txt",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes("k)~`:g.txt"), ["deletes a file with k's ~"]);
  assert.deepStrictEqual(writes("k)<`:o.txt"), ["opens a file with k's <"]);
  assert.deepStrictEqual(writes("k)>.z.w"), ["closes a handle with k's >"]);
  // Dyadic, or on a list, they compare, grade and match.
  for (const code of ["k)1~1", "k)<3 1 2", "k)>3 1 2", "k)x<y", "k)a~b", "k)~0 1b", "k)#t", "k)<\"cab\""]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("a string an evaluator, handle 0 or a gateway is given is read as value reads it, not as a script (#2274)", () => {
  const asks = [
    'value"\\n/\\na:77"', 'value"count t\\n/\\na:77"', 'value"count t\\n\\\\\\na:77"', 'get"count t\\n/\\na:77"', 'eval parse"count t\\n/\\na:77"',
    '0"count t\\n/\\na:77"', 'neg[0]"count t\\n/\\na:77"', '@[value;"count t\\n/\\na:77";::]', 'value/["count t\\n/\\na:77"]', '{value x}"count t\\n/\\na:77"',
    'value each enlist"count t\\n/\\na:77"', '.gw.syncexec["count t\\n/\\na:77";`rdb]', 'value"count t\\n/ c\\na:77"', 'value"1\\r\\n/\\r\\na:77"',
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  // A string that only reads, on lines of its own, reads.
  for (const code of ['value"count t\\n/ a comment\\n"', 'value"select from t\\n where a>1"', '.gw.syncexec["count t";`rdb]']) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("an assignment written as a call, :[a;77], assigns its first argument by the rules of a:77 (#2264)", () => {
  const cases = {
    ":[a;77]": ["assigns a"],
    "(:)[a;77]": ["assigns a"],
    "::[a;77]": ["assigns a"],
    "+:[a;1]": ["assigns a"],
    ",:[b;7]": ["assigns b"],
    "-:[a;1]": ["assigns a"],
    "(+:)[a;1]": ["assigns a"],
    "(,:)[b;7]": ["assigns b"],
    "(::)[a;77]": ["assigns a"],
    ":[b 0;77]": ["assigns b"],
    ":[d`a;77]": ["assigns d"],
    ":[.ns.v;77]": ["assigns .ns.v"],
    ":[.z.ts;{}]": ["assigns .z.ts"],
    ":[ a ;77]": ["assigns a"],
    "count t;:[a;77]": ["assigns a"],
    "$[1b;:[a;77];0]": ["assigns a"],
    "k):[a;77]": ["assigns a"],
    "{::[a;5]}[]": ["assigns a"],
    "{+:[a;1]}[]": ["assigns a"],
    "{:[.ns.v;1]}[]": ["assigns .ns.v"],
    // In a lambda, plainly, it is a local, as `a:5` is.
    "{:[a;5]; a}[]": [],
    "{[x] +:[x;1]; x}[1]": [],
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(writes(code), expected, code);
  }
  assert.deepStrictEqual(writes(":[(a;s);(1;2)]"), ["assigns a", "assigns s"]);
  // `:` as a value or a return is not one.
  for (const code of ["@[d;`a;:;1]", ".[d;enlist`a;:;9]", "{:x+1}[2]", "{$[x;:1;:2]}[1b]", "(:)", "0:[(\"SJ\";\",\");x]"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("eval of a tree reads the tree's head past its parentheses, and every list in it, as eval evaluates them (#2265)", () => {
  const asks = [
    "eval((:);`a;77)", "eval(+;0;(:;`a;77))", "eval(enlist;(:;`a;77))", "eval(count;(:;`a;77))", "-6!(+;0;(:;`a;77))", "reval(enlist;(:;`a;77))",
    "eval(enlist;(?;enlist`sym;enlist`zz))", "eval(+;0;(+;0;(@;enlist`b;0;:;77)))", "eval'[enlist (enlist;(:;`a;77))]", "eval[(+;0;(:;`a;77))]",
    "value((:);`a;77)", "eval((::);`a;77)", "eval((+:);`a;1)",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes("eval((:);`a;77)"), ["evaluates an assignment with eval"]);
  assert.deepStrictEqual(writes("eval(+;0;(:;`a;77))"), ["evaluates an assignment with eval"]);
  // A list value takes as they are: its items are not evaluated.
  for (const code of ["value(+;0;(:;`a;77))", "eval(?;`t;();0b;())", "eval(+;1;(*;2;3))", "eval parse\"select from t\"", "eval(count;(enlist;1;2))"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("an evaluator passed as a value - in parentheses, through an iterator, a composition, a list - is read on the trees around it (#2266)", () => {
  const asks = [
    "((eval))(:;`a;77)", "(eval')enlist(:;`a;77)", "eval/[(:;`a;77)]", "'[eval;::](:;`a;77)", "(eval/)(:;`a;77)", "(-6!)(:;`a;77)", "((-6!))(:;`a;77)",
    "((eval))(?;enlist`sym;enlist`zz)", "(eval;::)[0](:;`a;77)", "first[(eval;::)](:;`a;77)", "{x y}[eval;(count;(:;`a;77))]", "'[::;eval](eval;enlist(:;`a;77))",
    "(value/)((@);`b;0;:;77)", "(.q.eval)(enlist;(:;`a;77))", "(-6!;::)[0](:;`a;77)", "(-24!)(:;`a;77)", "{x}[eval](:;`a;77)", "(eval) . enlist(:;`a;77)",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  for (const code of ["(eval)(+;1;2)", "(eval')enlist(+;1;2)", "{x y}[eval;(count;1 2)]", "(-6!)(+;1;2)", "eval/[(*;2;3)]"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("handle 0 picked out of a list and applied to a tree evaluates it (#2266)", () => {
  assert.deepStrictEqual(writes("(0;::)[0]((@);`b;0;:;77)"), ["evaluates an amend on handle 0"]);
  assert.ok(writes("(0;::)[0](.;`b;enlist 0;:;77)").length > 0);
  for (const code of ["(0;1)[0]", "(0;1 2)[1]", "(0;::)[0](+;1;2)", "x:(0;1)[0]"]) {
    assert.deepStrictEqual(writes(code).filter((r) => !r.startsWith("assigns")), [], code);
  }
});

test("an evaluator given to a function that applies it - a trap's handler, .Q.fs, a projection - is read on what it may be given (#2268)", () => {
  const asks = [
    "@[{'x};\"a:77\";value]", "@[{'x};\"a:77\";get]", "@[{'x};\"a:77\";.h.val]", "@[{'x};\"a:77\";(value;::)0]", "@[{'x};\"a:77\";{value x}]",
    "@[{'x};`:o.txt;hopen]", ".[{'x};enlist `:o.txt;hopen]", ".Q.fs[value each;`:f.q]", ".Q.fs[{value each x};`:f.q]", ".Q.fsn[value each;`:f.q;100]",
    "@[;\"a:77\"] value", ".Q.trp[{'x};\"a:77\";{[e;b](value) e}]", "@[{'x};`boom;{[e](0) e}]", ".[{'x};enlist\"a:77\";{[e](get) e}]", "{x y}[value;\"a:77\"]",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes("@[{'x};\"a:77\";value]"), ["evaluates a string with value"]);
  assert.deepStrictEqual(writes(".Q.fs[value each;`:f.q]"), ["applies what .Q.fs is given to a file's lines: evaluates a string with value"]);
  // Handlers and line functions that only read, and value given a read.
  for (const code of [
    "@[value;\"count t\";{x}]", ".Q.trp[{count x};t;{-2 x;-2 .Q.sbt y;0}]", "@[{'x};`boom;{x}]", ".[{x+y};1 2;{-1 x;0}]", "@[get;`:f;()]",
    ".Q.fs[{count x};`:f.csv]", ".Q.fsn[{`t insert flip x}[;100];`:f.csv;1000]" , "@[;\"count t\"] value", "@[hopen;`:localhost:5000;0N]",
  ]) {
    assert.deepStrictEqual(writes(code).filter((r) => !/insert/.test(r)), [], code);
  }
  // The iterator's colon is not an assignment called (#2264).
  for (const code of ["{x,y}':[til 3]", "{x+y}/:[1;2 3]", "{x+y}\\:[1 2;3]"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("an amend, ?, !, eval or a writing lambda picked out of a list or a dictionary, or passed through {x}, is applied to what the guard cannot read (#2267)", () => {
  const asks = [
    "{x}[@][`b;0;:;77]", "(@;.)[0][`b;0;:;77]", "(.;::)[0][`b;enlist 0;:;77]", "(`a`b!(@;.))[`a][`b;0;:;77]", "(?;::)[0][`sym;`zz]", "{[f]f}[?][`sym;`zz]",
    "{x}[!][-11;`:tp.log]", "(eval;::)[0](:;`a;77)", "({.[x;();:;77]};{x})[0]`a", "(`w`r!({.[x;();:;77]};{x}))[`w]`a", "@[{x};!;::][-11;`:tp.log]",
    "(0;::)[0]\"a:77\"", "(-6!;::)[0](:;`a;77)", "({0};{.[x;();:;77]})@[1;::]`a",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  // Lists of functions that only read, and operators in lists with nothing to write to.
  for (const code of ["(`a`b!({x+1};{x*2}))[`a] 3", "({x+1};{x*2})[1] 3", "{x[0]} ({1};{2})", "(+;-)[0][1;2]", "(@;.)", "{x . y}[+;1 2]", "(0;1)[0]", "(`r`w!({0};{x}))[`w] 1"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("a by-name target computed by a lambda, a bracket call or a composition may be a symbol (#2269)", () => {
  const asks = [
    "@[{x}`b;0;:;77]", "update a:77 from {x}`t", "`a xdesc {x}`t", "xdesc[`a]{x}`t", "?[{x}`sym;`zz]", "{x}[`sym]?`zz", "![{x}`t;();0b;(enlist`a)!enlist 77]",
    ".[{x}`b;enlist 0;:;77]", "@[{y}[0;`b];0;:;77]", "@[.[{x};enlist`b];0;:;77]", "@[enlist[`b]0;0;:;77]", "update a:77 from enlist[`t]0", "@[;0;:;77]{x}`b",
    "{.[x;();:;77]}{x}`a", "@[@[{x};`b;::];0;:;77]", "@[{x}@`b;0;:;77]", "@[('[{x};::])`b;0;:;77]", "@[{x}[`b];0;:;77]",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes("@[{x}`b;0;:;77]"), ["amends what {x}`b names in place"]);
  // A lambda or a call given a value gives a value.
  for (const code of ["@[{x} t;`a;neg]", "update c:1 from {select from x} t", "`a xasc {x} t", "@[enlist[1 2]0;0;:;9]", "@[{x+1} 1 2;0;:;9]", "update b:a from {x}[t]"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("a lambda made a derived function by an iterator and applied infix is given its left argument (#2271)", () => {
  const asks = [
    "`b{@[x;0;:;y]}'77", "`a{.[x;();:;y]}/:77 78", "`a{.[x;();:;y]}\\:77", "`b{@[x;0;:;y]}/77", "`b{@[x;0;:;y]}\\77", "`a`c{.[x;();:;y]}'77 78",
    "`b{@[x;0;:;y]}':77", "`t{update a:y from x}'77", "`sym{x?y}'`zz", "`a{x set y}'77", "(`b){@[x;0;:;y]}'77", "v{.[x;();:;y]}/:77",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  assert.deepStrictEqual(writes("`b{@[x;0;:;y]}'77"), ["amends `b in place"]);
  for (const code of ["1 2{x+y}'3 4", "t{x lj y}/:(r;s)", "0{x+y}/1 2 3", "`a`b{x,y}'`c`d", "\"ab\"{x,y}/:\"cd\"", "count{x+1}'[1 2]"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("an amend projection composed with another function, or applied through an iterator after @, amends what the composition is given (#2270)", () => {
  const asks = [
    "'[@[;0;:;77];::]`b", "('[@[;0;:;77];{x}])`b", "(@[;0;:;77]first@)`b", "(@[;0;:;77]{x}@)`b", "(@[;0;:;77]) @/: enlist`b", "'[::;@[;0;:;77]]`b",
    "'[.[;();:;77];::]`a", "('[@[;0;:;77];::])[`b]", "(@[;0;:;77]) @' enlist`b", "'[@[;`a;:;1];::]`.",
  ];
  for (const code of asks) {
    assert.ok(writes(code).length > 0, code);
  }
  // Given a value, a composed amend changes a copy.
  for (const code of ["'[@[;0;:;77];::] b", "(@[;0;:;77]first@) (1 2;3 4)", "(@[;0;:;77]) @/: (1 2;3 4)", "'[@[;0;+;1];reverse] 1 2 3"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
});

test("a helper lambda that updates, sorts or keys a table it is given by name is read as given the table (#2277)", () => {
  for (const code of [
    "{x lj `sym xkey y}[trade;ref]", "{update mid:0.5*bid+ask from x} quote", "{`time xasc x} trade", "{[t] delete from t where size=0} trade", "{update a:1 from x}[t]",
    "{`sym xkey x} each (trade;quote)", "{![x;();0b;(enlist`c)!enlist(*;`price;2)]} trade", "{x lj `sym xkey y}/[trade;(r1;r2)]",
  ]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
  // Given a symbol, or amending what it is given, it is asked about as before (#2035).
  for (const code of ["{`time xasc x} `trade", "{update a:1 from x}`t", "{.[x;();:;1]} v", "{x set 1} v", "{@[x;0;:;1]} v", "{hopen x} f"]) {
    assert.ok(writes(code).length > 0, code);
  }
});

test("a system command's argument is read past a comment after it", () => {
  for (const code of ["\\t 100 /c", "k)\\t\t100 /c", "\\t 100 / set the timer"]) {
    assert.deepStrictEqual(writes(code), ["sets the timer with \\t"], code);
  }
  assert.deepStrictEqual(writes("\\t count t /c"), []);
  assert.deepStrictEqual(writes("\\cd /tmp"), ["runs the system command \\cd"]);
});

test("an assignment call after an operator applied infix, and a lambda iterated by a keyword, are read as q reads them (#2264, #2271)", () => {
  assert.deepStrictEqual(writes("0N!:[.z.ts;{}]"), ["assigns .z.ts"]);
  assert.deepStrictEqual(writes("1+:[a;2]"), ["assigns a"]);
  assert.deepStrictEqual(writes("{[x;y;z]::[a;77]}[0;0;0]"), ["assigns a"]);
  // `each` takes the function on its left: what is left of that is not its argument.
  assert.deepStrictEqual(writes("enlist {update v:77 from x} each enlist {`e}[]"), ["updates what ({`e}[]) names in place"]);
  assert.deepStrictEqual(writes("count{x+1}'[1 2]"), []);
});

test("csv, q's own \",\", is a format on the left of 0: - text prepared, no file written (#2643)", () => {
  for (const code of ["csv 0: t", ".q.csv 0: t", "(csv) 0: t", "-1 csv 0: t"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
  assert.deepStrictEqual(writes("`:f.csv 0: csv 0: t"), ["writes the file `:f.csv with 0:"]);
  assert.deepStrictEqual(writes("h 0: t"), ["writes a file with 0:"]);
});

test("hopen of an http or https URL, as .Q.hg opens it, connects: no file is opened (#2646)", () => {
  for (const code of ["hopen `:http://example.com", "hopen `:https://example.com:443"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
  assert.deepStrictEqual(writes("hopen `:http.txt"), ["opens the file `:http.txt with hopen"]);
});

test("handle 0 written with extra zeros is handle 0: the string is evaluated there (#2623)", () => {
  for (const code of ['00"a:1"', '0000"a:1"', '00i"a:1"', '-00"a:1"', '(00)"a:1"', '00j@"a:1"']) {
    assert.deepStrictEqual(writes(code), ["evaluates a string on handle 0"], code);
  }
  assert.deepStrictEqual(writes('00"count t"'), []);
});

test("the expression after \\t or \\ts is read whole: a \" /\" in a string in it hides nothing (#2622)", () => {
  assert.deepStrictEqual(writes('\\t count " /";zz::1'), ["assigns zz"]);
  assert.deepStrictEqual(writes('\\ts {x} " /";`zz set 1'), ["calls set"]);
  assert.deepStrictEqual(writes('\\t "a /b";hdel `:f'), ["calls hdel"]);
  // A comment after it is still none of it.
  assert.deepStrictEqual(writes("\\t count t /zz::1"), []);
});

test("\\v, \\f, \\a and \\b given a namespace list its names: a read (#2645)", () => {
  for (const code of ["\\v .q", "\\f .q", "\\a .", "\\b .ns", "\\v .a.b", 'system "v .q"', 'system "f .q"']) {
    assert.deepStrictEqual(writes(code), [], code);
  }
  assert.deepStrictEqual(writes("\\v x"), ["runs the system command \\v"]);
});

test("the workers of .Q.L and .Q.bv, and .Q.dbg, assign globals or load a database: they are writers (#2631)", () => {
  for (const name of [".Q.MAP", ".Q.L1", ".Q.bvfp", ".Q.dbg"]) {
    assert.deepStrictEqual(writes(`${name}[x]`), [`calls ${name}`], name);
  }
  assert.deepStrictEqual(writes(".Q.MAP[]"), ["calls .Q.MAP"]);
});

test(".z.ph and .h.jx value the query string they are given, as .h.val does: they are asked about (#2632)", () => {
  assert.deepStrictEqual(writes('.z.ph("?zp:1";()!())'), ["calls .z.ph"]);
  assert.deepStrictEqual(writes('.h.jx[0j;"zz:1"]'), ["calls .h.jx"]);
  assert.deepStrictEqual(writes('.h.jx[0j] "zz:1"'), ["calls .h.jx"]);
});

test("upsert on a value - a name alone or a table written out - gives a new table: a read (#2644)", () => {
  for (const code of ["t upsert s", "([]a:1 2) upsert ([]a:enlist 3)", "kt upsert s", "([k:1 2]v:3 4) upsert (1;5)", "d upsert `a`b!1 2"]) {
    assert.deepStrictEqual(writes(code), [], code);
  }
  // On a symbol, in brackets, or inside a lambda given a name, it is asked about.
  for (const code of ["`t upsert s", "(`t) upsert s", "`:db/t/ upsert s", "upsert[`t;s]", "{x upsert y}[`t;s]"]) {
    assert.ok(writes(code).includes("calls upsert"), code);
  }
  // What the right side does is still read.
  assert.deepStrictEqual(writes("t upsert `:f set 1"), ["calls set"]);
});
