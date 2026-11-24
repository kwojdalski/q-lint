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

test("a three-argument amend with an attribute or a unary is a change (#1323)", () => {
  const cases = {
    "@[`t;`c;`p#]": ["amends `t in place"],
    "@[`t;`a;`s#]": ["amends `t in place"],
    "@[`t;`a;neg]": ["amends `t in place"],
    ".[`t;(0;`a);neg]": ["amends `t in place"],
    // A trap by name, or on a value, reads.
    ".[`f;(1;2);{x}]": [],
    "@[`f;x;::]": [],
    "@[`f;x;`err]": [],
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
    "(.)[`f;(1;2);{x}]": [],
    "(@)[f;x;{y}]": [],
    "(!)[t;();0b;`a]": [],
    "(x+1)[0]": [],
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
