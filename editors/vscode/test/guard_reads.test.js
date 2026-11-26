// The read-only guard (#918) must not ask about code that only reads: a
// guard that asks about everything is a guard people turn off. Typical
// read-only queries, and the extension's own query lambdas, which it sends
// constantly, are each read here as code that changes nothing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { writes } = require("../out/guard.js");

/// What people send to a production process to look at it.
const READS = [
  // select and exec
  "select from trade",
  "select from trade where date=.z.d",
  "select from trade where sym=`AAPL",
  "select from trade where sym in `AAPL`MSFT, price>100",
  "select last price by sym from trade",
  "select vwap:size wavg price by sym from trade where date=.z.d",
  "select count i by sym from trade",
  "select max price, min price by 5 xbar time.minute from trade",
  "select[10] from trade",
  "select[-10;>price] from trade",
  "select from trade where i<100",
  "select distinct sym from trade",
  "select sym, price from trade where size within 100 200",
  "select from trade where sym like \"A*\"",
  "select from trade where price=(max;price) fby sym",
  "select from trade where not null bid",
  "exec price from trade",
  "exec distinct sym from trade",
  "exec sym!price from trade",
  "exec count i by sym from trade",
  "exec first price from trade where sym=`AAPL",
  "select from (select from trade where sym=`AAPL) where price>1",
  // update and delete on a value, which change a copy
  "update mid:0.5*bid+ask from quote",
  "update spread:ask-bid from quote where sym=`AAPL",
  "update c:a*2 from t",
  "update x:sums size by sym from trade",
  "delete from trade where size=0",
  "delete bid from quote",
  "update a:0 from select from t",
  "delete from 0!kt where v>10",
  // meta, counts and the like
  "meta trade",
  "count trade",
  "count each `trade`quote!(trade;quote)",
  "cols trade",
  "key kt",
  "value kt",
  "type trade",
  "tables[]",
  "tables`.",
  "views[]",
  "key`.",
  "key`:.",
  "system\"d\"",
  "system \"c\"",
  "\\a",
  "\\v",
  "\\d",
  "\\c",
  "\\P",
  "\\w",
  "\\t select from trade",
  "\\ts count trade",
  "\\t:10 count trade",
  ".Q.w[]",
  ".Q.s trade",
  ".Q.pt",
  ".Q.pv",
  ".Q.PD",
  ".Q.ty trade`price",
  "first trade",
  "last trade",
  "5#trade",
  "-5#trade",
  "10 sublist trade",
  "trade 0",
  "trade[0;`price]",
  "trade`price",
  "kt 1",
  "flip trade",
  "0!kt",
  "1!trade",
  "reverse trade",
  "distinct trade`sym",
  "ungroup t",
  "raze (t;t)",
  "t,t",
  "asc trade`price",
  "til 10",
  "sum trade`size",
  "avg trade`price",
  "group trade`sym",
  "count each group trade`sym",
  "1 2 3?2",
  "`p`q?`q",
  "`a`b!1 2",
  "string trade`sym",
  "show trade",
  "-1 \"hello\";",
  "0N!count trade",
  ".z.p",
  ".z.d",
  ".z.h",
  "-8!trade",
  "-9!-8!trade",
  "-22!trade",
  "get`trade",
  "value`trade",
  "value\"select from trade\"",
  "value\"count t\"",
  "parse\"select from t\"",
  // joins
  "aj[`sym`time;trade;quote]",
  "aj0[`sym`time;trade;quote]",
  "lj[trade;kt]",
  "trade lj `sym xkey ref",
  "trade ij `sym xkey ref",
  "trade uj quote",
  "ej[`sym;trade;ref]",
  "wj[w;`sym`time;trade;(quote;(max;`ask);(min;`bid))]",
  "wj1[w;`sym`time;trade;(quote;(max;`ask))]",
  "pj[t;kt]",
  "t ^ kt",
  // xkey, xasc, xcol on a value
  "`sym xkey trade",
  "`sym`time xkey select from trade",
  "() xkey kt",
  "`price xasc trade",
  "`price xdesc select from trade",
  "`a`b xcol t",
  "`sym xcols trade",
  "xasc[`price;trade]",
  "xkey[`sym;trade]",
  // functional forms on a value
  "?[trade;();0b;()]",
  "?[trade;enlist(=;`sym;enlist`AAPL);0b;()]",
  "?[trade;();(enlist`sym)!enlist`sym;(enlist`p)!enlist(max;`price)]",
  "?[trade;();();`price]",
  "![trade;();0b;(enlist`c)!enlist(*;`price;2)]",
  "![trade;enlist(=;`size;0);0b;`symbol$()]",
  "@[t;`a;neg]",
  "@[t;`a;:;1 2 3]",
  ".[t;(0;`a);:;7]",
  "@[d;`a;+;1]",
  "@[1 2 3;0;+;1]",
  // .Q helpers that read
  ".Q.ind[trade;0 1 2]",
  ".Q.ind[trade;til 10]",
  ".Q.fu[{x+1};1 2 1]",
  ".Q.id t",
  ".Q.qt trade",
  ".Q.qp trade",
  ".Q.f[2;3.14159]",
  ".Q.fmt[6;2;3.14159]",
  ".Q.gc[]",
  ".Q.btoa \"x\"",
  // lambdas that read, applied
  "{x+1} each 1 2 3",
  "{select from trade where sym=x}`AAPL",
  "{[s] select from trade where sym=s}[`AAPL]",
  "{exec max price from trade where sym=x} each `AAPL`MSFT",
  "{count x} each (trade;quote)",
  "{[t;n] n sublist t}[trade;10]",
  "{a:1; a+x}[2]",
  "{t:select from trade; update c:1 from t}[]",
  "{s:`AAPL; select from trade where sym=s}[]",
  "{f:{x+1}; f 2}[]",
  "$[1b;count trade;0]",
  "if[1b;count trade]",
  "do[3;count trade]",
  "@[{count x};trade;{x}]",
  ".[{x+y};1 2;{x}]",
  ".Q.trp[{count x};trade;{x}]",
  "{x[`sym]}[trade]",
  "raze {select from trade where sym=x} each `AAPL`MSFT",
  "neg[.z.w] \"x\"",
  "hopen `:localhost:5000",
  "hopen (`:localhost:5000;1000)",
  "{h:hopen 5000; h\"count t\"}[]",
];

test("typical read-only queries are not asked about", () => {
  assert.ok(READS.length >= 100, `${READS.length} reads`);
  const asked = READS.map((code) => [code, writes(code)]).filter(([, w]) => w.length > 0);
  assert.deepStrictEqual(asked, []);
});

/// The extension's own query lambdas that change the process by design, or
/// that the guard reads as one: each says why.
const OWN_WRITES = new Map([
  ["attradvice.js ATTRIBUTE_SAMPLE", "gets a name it is given, a string to get"],
  ["benchmark.js BENCHMARK", "runs the expressions it is given"],
  ["colmanager.js RUN_SCRIPT", "runs a script and updates .qlint"],
  ["dbdoc.js DOCUMENT", "runs system commands"],
  ["editorassist.js PROCESS_NAMES", "calls system with a built string"],
  ["explorer.js GATHER", "gets names it builds"],
  ["funcsource.js REDEFINE", "redefines a function"],
  ["funcsource.js CALLERS", "applies a lambda to what it is given"],
  ["instrument.js DEFINE_AS", "sets \\d to read a function's text in its own context"],
  ["linetimings.js LINE_TIMINGS", "runs the code it is given"],
  ["logpoint.js LOG_ADD", "replaces a function with one that logs"],
  ["logpoint.js LOG_REMOVE", "puts a function back"],
  ["monitor.js MONITOR", "calls system as a value"],
  ["profile.js PROFILE", "wraps functions"],
  ["profile.js PROFILE_CLEANUP", "unwraps functions"],
  ["remotefiles.js LIST_DIRECTORY", "runs a shell command"],
  ["remotefiles.js READ_FILE", "runs a shell command"],
  ["snapshot.js SNAPSHOT_RUN", "sets \\c"],
  ["snapshot.js SNAPSHOT_RUN_READ_ONLY", "sets \\c"],
  ["syssettings.js READ_SETTINGS", "calls system as a value"],
  ["syssettings.js SET_SETTING", "sets a setting"],
  ["testing.js TEST_RUN", "runs tests"],
  ["timers.js TIMERS", "calls system as a value"],
]);

test("the extension's own query lambdas that only read are not asked about", () => {
  const out = path.join(__dirname, "..", "out");
  const lambdas = [];
  for (const file of fs.readdirSync(out).filter((f) => f.endsWith(".js")).sort()) {
    let exported;
    try {
      exported = require(path.join(out, file));
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(exported)) {
      if (typeof value === "string" && /^\s*\{/.test(value) && value.includes("}")) {
        lambdas.push([`${file} ${name}`, value]);
      }
    }
  }
  assert.ok(lambdas.length > OWN_WRITES.size + 30, `${lambdas.length} lambdas`);
  const asked = lambdas.filter(([id, code]) => !OWN_WRITES.has(id) && writes(code).length > 0).map(([id, code]) => [id, writes(code)]);
  assert.deepStrictEqual(asked, []);
});
