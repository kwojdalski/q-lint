// The q side of #1054, #1057 and #1061 against a real q process: every
// example in the error catalogue raises the error it explains, the dead
// code report's process check finds the candidates a function the process
// holds names, and the SQL tab's query runs on KDB-X's SQL engine (PeachQ's
// own `.s.e`, backed by DuckDB, refuses it with 'duckdb where DuckDB is not
// installed). Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { ERRORS, errorName } = require("../out/errorexplain.js");
const { CALLED } = require("../out/deadcodeview.js");
const { HAS_SQL, LOAD_SQL, LEX_CLASS, LEX_MOVES, RUNS_Q, SQL_SCHEMA, readSchema, sqlQuery, sqlText, sqlWrites } = require("../out/sql.js");
const { statements } = require("../out/statements.js");
const { registerSql } = require("../out/sqlview.js");
const { LANGUAGE_COMMANDS } = require("../out/languagefeatures.js");
const { guardCheck, readGuard } = require("../out/guard.js");

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

async function connect(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-lang-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true, cwd: dir });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  t.after(stop);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) {
      const connection = await QConnection.open({ host: "127.0.0.1", port });
      t.after(() => connection.close());
      return connection;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("q did not start listening");
}

test("every example in the error catalogue raises the error it explains", { skip }, async (t) => {
  const c = await connect(t, "t:([k:1 2]v:3 4)\n");
  for (const [name, entry] of Object.entries(ERRORS)) {
    if (entry.example === undefined || entry.checked === "documented") {
      continue;
    }
    const answer = await c.call("{r:@[{(1b;value x)};x;{(0b;x)}]; $[r 0;\"(no error)\";r 1]}", ` ${entry.example}`);
    const got = errorName(String(answer));
    // PeachQ names some differently, as the catalogue says.
    const alternative = /reports '([a-z-]+)/.exec(entry.peachq ?? "")?.[1];
    assert.ok(got === name || got === alternative, `${name}: ${entry.example} raised '${got}'`);
  }
});

test("the dead code report's process check finds what a function the process holds names", { skip }, async (t) => {
  const c = await connect(t, ["\\d .util", "helper:{x+1}", "caller:{helper x}", "other:{x}", "\\d .", "top:{x}", "usesTop:{top 1}", "alone:{x}", "f:{x}", "runner:{.util.other x}", ".cfg:42", ""].join("\n"));
  const got = await c.call(CALLED, ".util.helper .util.other top alone nothere f");
  const names = (Array.isArray(got) ? got : [got]).map(String).sort();
  // `alone` and `f` are named by no other function; `nothere` by none;
  // `.util.other` only by its whole name (#1227). `.cfg`, a root name that
  // is no namespace, lists nothing and fails nothing (#1370).
  assert.deepStrictEqual(names, [".util.helper", ".util.other", "top"]);
});

test("the process check reads nested namespaces, and the lambdas a projection, a composition or a dictionary holds (#1901)", { skip }, async (t) => {
  const source = [
    "helper:{x+1}", "other:{x+2}", "third:{x}", "fourth:{x}", "fifth:{x}", "sixth:{x}", "seventh:{x}", "eighth:{x}", "alone:{x}", "rec:{$[x>0;rec x-1;x]}",
    ".app.top:{helper x}",
    ".app.rest.deep:{other x}",
    "handlers:`a`b!({third x};{x})",
    ".z.ts:{fourth x}",
    "proj:{[a;b] fifth a}[;1]",
    "comp:('[{sixth x};{x}])",
    "eachOf:{seventh x}'",
    ".app.rest.table:`get`put!(({eighth x};1);({x}/;2))",
    // Data is not read as code: a string, a table, a view.
    "note:\"alone\"", "tbl:([]a:`alone`b)", "vw::alone 1",
    "",
  ].join("\n");
  const c = await connect(t, source);
  const held = () => c.call("{string each(key`;key`.)}", null);
  const before = await held();
  const got = await c.call(CALLED, "helper other third fourth fifth sixth seventh eighth alone rec nothere");
  const names = (Array.isArray(got) ? got : [got]).map(String).sort();
  // PeachQ, which has a `.help` of its own, lists no `.z` handler.
  const peach = before[0].map(String).includes("help");
  assert.deepStrictEqual(names, ["eighth", "fifth", ...(peach ? [] : ["fourth"]), "helper", "other", "seventh", "sixth", "third"]);
  // Nothing was defined by asking.
  assert.deepStrictEqual(await held(), before);
});

test("the SQL tab's query runs on KDB-X's SQL engine, loading it where there is none", { skip }, async (t) => {
  const c = await connect(t, "t:([]sym:`a`b`a;px:1 2 3f;size:10 20 30)\n");
  const schema = readSchema(await c.call(SQL_SCHEMA));
  assert.deepStrictEqual(schema.get("t"), ["sym", "px", "size"]);
  const had = await c.call(HAS_SQL);
  const kdbx = String(await c.call(".z.K")) >= "5" && had === false;
  let answer;
  try {
    answer = await c.call(sqlQuery("select sym, sum(size) as total -- per sym\nfrom t group by sym", true));
  } catch (error) {
    // PeachQ's `.s.e` needs DuckDB.
    assert.ok(!kdbx && /duckdb/.test(error.message), error.message);
    return;
  }
  assert.strictEqual(await c.call(HAS_SQL), true);
  const rows = Array.isArray(answer) ? answer : [];
  assert.deepStrictEqual(rows.map((r) => [String(r.sym), Number(r.total)]), [["a", 40], ["b", 20]]);
  // Loaded once: the plain form runs now.
  const again = await c.call(sqlQuery("select count(*) as n from t"));
  assert.strictEqual(Number((Array.isArray(again) ? again : [])[0]?.n), 3);
  // A write behind a block comment still writes, and Run SQL asks about it.
  const hidden = "/* note */ insert into t values ('c', 4.0, 40)";
  assert.deepStrictEqual(sqlWrites(hidden), ["INSERT"]);
  await c.call(sqlQuery(hidden));
  assert.strictEqual(Number(await c.call("count t")), 4);
});

// #1955: the write check reads SQL as the engine's lexer does, not as SQL
// has it. Its tables are KDB-X's own, an INSERT behind a `--` comment that
// a form feed, a lone CR or a backslash ends is seen, and for generated
// text every write word the lexer gives the parser is one the check gives.
test("the SQL write check reads comments and quotes as KDB-X's lexer does", { skip }, async (t) => {
  const c = await connect(t, "t:([] a:1 2 3; b:`x`y`z)\n");
  try {
    await c.call(LOAD_SQL);
    await c.call(".s.P.w0");
  } catch {
    // PeachQ: no s.k_, and a lexer of DuckDB's.
    return;
  }
  assert.strictEqual(await c.call('"0123456789abc" .s.P.w0'), LEX_CLASS);
  assert.deepStrictEqual(await c.call(".s.P.ww"), LEX_MOVES);
  const count = async () => Number(await c.call("count t"));
  // q itself refuses ('char) a statement holding any other control character.
  for (const end of ["\f", "\r", "\\"]) {
    const sql = `select 1 /* ' */ -- x${end}; insert into t values (21,'a')`;
    const before = await count();
    await c.call(sqlQuery(sql));
    assert.strictEqual(await count(), before + 1, `the comment ends at ${JSON.stringify(end)}`);
    assert.deepStrictEqual(sqlWrites(sqlText(sql)), ["INSERT"], JSON.stringify(sql));
  }
  // A tab does not end the comment: nothing is written, and nothing asked.
  const tabbed = "select 1 /* ' */ -- x\t; insert into t values (21,'a')";
  const rows = await count();
  await c.call(sqlQuery(tabbed));
  assert.strictEqual(await count(), rows);
  assert.deepStrictEqual(sqlWrites(sqlText(tabbed)), []);
  // #1956: a `--` inside a block comment is not cut, so the WHERE is sent.
  const one = await c.call(sqlQuery("select * from t /* see a--b */ where a = 1"));
  assert.deepStrictEqual((Array.isArray(one) ? one : []).map((r) => Number(r.a)), [1]);
  // Quoted text runs across lines: the `--` in it stays, and the INSERT
  // after it is text in the next quote, as typed and as sent (#1408's case).
  const quoted = "select 'a\n--'\n' as c from t; insert into t values (1) -- '";
  const held = await count();
  await c.call(sqlQuery(quoted)).catch(() => undefined);
  assert.strictEqual(await count(), held);
  assert.deepStrictEqual(sqlWrites(sqlText(quoted)), []);
  // Generated text, as typed and as sent. `LEXERR`: the lexer refused it,
  // so nothing of it runs.
  const pieces = ["insert", "drop", "INSERT", "--", "-", "/*", "*/", "*", "/", "'", '"', "''", ".", "x", "x.-", "1", "e", "1e", "_", " ", " ", "\t", "\n", "\r", "\f", "\u0001", "\\", ";", "(", "é"];
  let seed = 1955;
  const next = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const texts = [];
  for (let i = 0; i < 1500; i++) {
    const text = Array.from({ length: 1 + next(12) }, () => pieces[next(pieces.length)]).join("");
    texts.push(text, sqlText(text));
  }
  const corpus = [...new Set(texts)].filter((x) => x !== "");
  const words = "{@[{asc distinct w where (w:`$upper each (),/:.s.P.w x) in `INSERT`DROP};x;{enlist`LEXERR}]}";
  let read = 0;
  for (let i = 0; i < corpus.length; i += 50) {
    const chunk = corpus.slice(i, i + 50);
    const answer = await c.call(`${words} each (${chunk.map((x) => `"c"$(),0x${Buffer.from(x, "utf8").toString("hex")}`).join(";")};"")`);
    chunk.forEach((text, k) => {
      const lexed = [...answer[k]].map(String);
      if (lexed.includes("LEXERR")) {
        return;
      }
      read++;
      const ours = sqlWrites(text).sort();
      for (const w of lexed) {
        assert.ok(ours.includes(w), `${JSON.stringify(text)}: the lexer gives ${w}, the check ${JSON.stringify(ours)}`);
      }
      // The two agree to the word where only one reading is possible: no
      // line end for SQL's own to stop at, no `.-` the parser refuses.
      if (!/[\n.]/.test(text)) {
        assert.deepStrictEqual(ours, lexed, JSON.stringify(text));
      }
    });
  }
  assert.ok(read > 1000, `${read} texts read`);
});

// #2009: quoted text is the query's own, line breaks and indents with it.
test("a SQL string literal that spans lines finds the row that holds it, as typed", { skip }, async (t) => {
  const c = await connect(t, 'w:([] s:("a\\n   b";"a b";"x  y";"it\'s\\r\\n so";"it\'s so"); n:1 2 3 4 5)\n');
  try {
    await c.call(LOAD_SQL);
    await c.call(".s.P.w0");
  } catch {
    // PeachQ: no s.k_, and an engine of DuckDB's.
    return;
  }
  // As Run SQL sends it: the one statement `statements` cuts.
  const found = async (sql) => {
    const cut = statements(sqlQuery(sql));
    assert.strictEqual(cut.length, 1, sql);
    const rows = await c.call(cut[0]);
    return (Array.isArray(rows) ? rows : []).map((r) => Number(r.n));
  };
  assert.deepStrictEqual(await found("select n from w\n  where s = 'a\n   b'\n;"), [1]);
  assert.deepStrictEqual(await found("select n -- which\n  from w where s = 'a b'"), [2]);
  assert.deepStrictEqual(await found("select n from w where s = 'x  y'"), [3]);
  assert.deepStrictEqual(await found("select n from w where s = 'it''s\r\n so'"), [4]);
  assert.deepStrictEqual(await found("select n from w\n\n where s = 'it''s so' /* a\n   b */"), [5]);
});

// #2006: the engine runs q text handed to `qt(...)` and `q(...)`. On the q
// under test: which functions of the engine's own table run q, each way of
// writing a call held by the read-only guard on a production-tagged
// process and a write once let through, and for generated text no call
// that ran q unasked.
const SET = "`gz set 99";
const ENGINE = 'm:([] a:1 2 3)\nst:([] c:("`gz set 99; 1";"`gz set 99; 1"))\ngz:0\n';

async function engine(t) {
  const c = await connect(t, ENGINE);
  try {
    await c.call(LOAD_SQL);
    await c.call(".s.P.w0");
    return c;
  } catch {
    // PeachQ: no s.k_, and an engine of DuckDB's.
    return undefined;
  }
}

test("of the engine's function table only q runs q text, and qt beside it (#2006)", { skip }, async (t) => {
  const c = await engine(t);
  if (c === undefined) {
    return;
  }
  // Each named function with q text in each place of its arguments, a
  // literal's and a column's, wherever an expression or a table stands.
  const ran = [
    "{[n]",
    ` t:"'${SET}; 1'";`,
    ' a:(t;t,",",t;t,",",t,",",t;"\'j\',",t;"1,",t;t,",1";"c";"\'j\',c";"\'j\',\'value\',c";"c,",t);',
    ' f:raze {[n;a] ("select ",n,"(",a,")";"select ",n,"(",a,") from st";"select * from ",n,"(",a,")";"select * from st where 1 = ",n,"(",a,")")}[n] each a;',
    " any {`gz set 0; @[.s.e;x;{x}]; 99=gz} each f}",
  ].join("");
  const names = [...(await c.call("{string k where -11h=type each k:key .s.F}[]"))].map((n) => (Array.isArray(n) ? n.join("") : String(n)));
  assert.ok(names.includes("q") && names.length > 100, `${names.length} functions`);
  const running = [];
  for (const name of [...names, "qt"]) {
    if (await c.call(ran, name)) {
      running.push(name.toUpperCase());
    }
  }
  assert.deepStrictEqual(running.sort(), [...RUNS_Q].sort());
  assert.strictEqual(Number(await c.call("count m")), 3);
});

test("SQL that runs q is held on a production-tagged process, and is a write once let through (#2006)", { skip }, async (t) => {
  const c = await engine(t);
  if (c === undefined) {
    return;
  }
  stub.reset();
  vscode.languages.registerCompletionItemProvider = () => ({ dispose() {} });
  t.after(() => (vscode.window.activeTextEditor = undefined));
  const settings = readGuard((key, fallback) => fallback);
  const prod = { label: "prod1", tags: ["prod"] };
  const asked = [];
  let confirm = false;
  const live = {
    activeLabel: () => undefined,
    fileBinding: () => "prod1",
    processes: () => [prod],
    // The guard itself, the user answering `confirm`.
    guardAllows: async (code, targets, what) => guardCheck(code, targets, settings) === undefined || (asked.push(what), confirm),
    queryCode: async (code) => void (await c.call(code).catch(() => undefined)),
  };
  registerSql(stub.newContext(), live);
  const run = async (sql) => {
    vscode.window.activeTextEditor = { document: { languageId: "sql", uri: { toString: () => "untitled:2006" }, getText: () => sql }, selection: { isEmpty: true } };
    await c.call("gz::0");
    await stub.commands.get(LANGUAGE_COMMANDS.runSql)();
    return Number(await c.call("gz"));
  };
  const table = `('${SET}; m')`;
  const value = `('j', '${SET}; 1')`;
  const forms = [
    // The issue's own, then the name in any case, with blanks, comments and
    // the lexer's other blanks before the bracket, and in double quotes.
    [`select * from qt${table}`, "QT()"],
    [`select * from QT${table}`, "QT()"],
    [`select * from Qt \t ${table}`, "QT()"],
    [`select * from qt\n${table}`, "QT()"],
    [`select * from qt/* c */${table}`, "QT()"],
    [`select * from qt -- c\n${table}`, "QT()"],
    [`select * from qt\f${table}`, "QT()"],
    [`select * from qt\\${table}`, "QT()"],
    [`select * from "qt"${table}`, "QT()"],
    [`select * from "QT" /* c */ ${table}`, "QT()"],
    [`select * from " qt\t"${table}`, "QT()"],
    [`select*from(qt${table})`, "QT()"],
    [`select * from m, qt${table}`, "QT()"],
    [`with z as (select * from qt${table}) select 1`, "QT()"],
    [`select a from m where exists (select 1 from qt${table})`, "QT()"],
    [`select q${value}`, "Q()"],
    [`select Q ${value} from m`, "Q()"],
    [`select q/* c */\t${value}`, "Q()"],
    [`select q -- c\n ${value}`, "Q()"],
    [`select q\\${value}`, "Q()"],
    [`select "q"${value}`, "Q()"],
    [`select " Q " ${value}`, "Q()"],
    [`select -q${value}`, "Q()"],
    [`select 1+q${value}`, "Q()"],
    [`select a from m where a in (q('J', '${SET}; 1 2'))`, "Q()"],
    [`select a from m where 1 = "q"${value}`, "Q()"],
    [`select a from m order by q${value}`, "Q()"],
    [`select count(*) from m group by q${value}`, "Q()"],
    [`select cast(q${value} as int)`, "Q()"],
    [`select 1 union select q${value}`, "Q()"],
    // q text that is no literal of the call: a cast's, and a column's.
    [`select q('j', cast('${SET}; 1' as text))`, "Q()"],
    ["select q('j', 'value', c) from st", "Q()"],
  ];
  for (const [sql, word] of forms) {
    confirm = false;
    const before = asked.length;
    assert.strictEqual(await run(sql), 0, `ran unasked: ${JSON.stringify(sql)}`);
    assert.deepStrictEqual(asked.slice(before), [`This SQL statement (${word})`], JSON.stringify(sql));
    confirm = true;
    assert.strictEqual(await run(sql), 99, `no write once confirmed: ${JSON.stringify(sql)}`);
  }
  // A plain read is sent unasked.
  const before = asked.length;
  vscode.window.activeTextEditor = undefined;
  assert.strictEqual(await run("select q, qt from (select a as q, a as qt from m) z"), 0);
  assert.strictEqual(asked.length, before);
  assert.strictEqual(Number(await c.call("count m")), 3);
});

test("no generated SQL runs q without the write check seeing a call (#2006)", { skip }, async (t) => {
  const c = await engine(t);
  if (c === undefined) {
    return;
  }
  // A call as `qt` is made and as `q` is, then what may stand before the
  // name, the name's own spellings and what may stand before the bracket.
  const made = [
    [["select * from ", "select * from m, ", "select*from(", "select 1; select * from "], ["qt", "QT", "Qt", '"qt"', '" QT\t"'], [`('${SET}; m')`, `('${SET}; m') z`, `('${SET}; m'))`]],
    [["select ", "select -", "select 1+", "select a from m where 1 = ", "select (", "select 1,"], ["q", "Q", '"q"', '" Q "', '"q\r"'], [`('j','${SET}; 1')`, `('J','${SET}; 1 2')`, "('j','value',c) from st", `('j','${SET}; 1') from m`, `('j','${SET}; 1'))`]],
  ];
  const lead = ["select 1", "select m.", "select _", "select 'x'", "select /* ", "select -- ", "select '", "select \"x\" ", "select * from (", "", "x"];
  const name = ['"q\n"', "'q'", "'qt'", '"q""t"', '"q"t', "qq", "q_", "q1", "q.q", "q.", "1q", '""q', "q''"];
  const gap = ["", "", "", " ", "\t", "\n", "\r", "\f", "\u0001", "\\", "/* c */", "/* ' */", "/* -- */", "-- c\n", "-- c\f", "-- c\t", "-- '\n", "''", '""', "x", ".", "-", ";", "("];
  const tail = [`'${SET}; m'`, `(('${SET}; m'))`];
  // The generator's high bits: its low ones repeat every few draws.
  let seed = 2006;
  const next = (n) => Math.floor(((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * n);
  const one = (from, others) => (next(4) > 0 ? from[next(from.length)] : others[next(others.length)]);
  const texts = [];
  for (let i = 0; i < 2500; i++) {
    const [leads, names, tails] = made[next(2)];
    const all = made.flat();
    const text = one(leads, [...lead, ...all[0], ...all[3]]) + one(names, [...name, ...all[1], ...all[4]]) + Array.from({ length: next(3) }, () => gap[next(gap.length)]).join("") + one(tails, [...tail, ...all[2], ...all[5]]);
    texts.push(text, sqlText(text));
  }
  const corpus = [...new Set(texts)].filter((x) => x !== "");
  const ran = "{`gz set 0; @[.s.e;x;{x}]; 99=gz}";
  let wrote = 0;
  let unasked = 0;
  for (let i = 0; i < corpus.length; i += 50) {
    const chunk = corpus.slice(i, i + 50);
    const answer = await c.call(`${ran} each (${chunk.map((x) => `"c"$(),0x${Buffer.from(x, "utf8").toString("hex")}`).join(";")};"")`);
    chunk.forEach((text, k) => {
      const calls = sqlWrites(text).filter((w) => w.endsWith("()"));
      if (answer[k]) {
        wrote++;
        assert.ok(calls.length > 0, `${JSON.stringify(text)} ran q, and the check gives ${JSON.stringify(sqlWrites(text))}`);
      } else if (calls.length === 0) {
        unasked++;
      }
    });
  }
  // Enough of them ran q for that to mean something, and it is no check
  // that asks about everything.
  assert.ok(wrote > 300, `${wrote} texts ran q`);
  assert.ok(unasked > 300, `${unasked} texts not asked about`);
  assert.strictEqual(Number(await c.call("count m")), 3);
  assert.deepStrictEqual([...(await c.call("key `."))].map(String).sort(), ["gz", "m", "st"]);
});
