// The HDB column manager (#1022): add, delete, rename or cast a column, or
// set its attribute, in every partition of a partitioned table, or in a
// splayed one, as a q script to review before it runs. Free of any `vscode`
// import, so node tests it; `dbtoolsview.ts` shows the script and runs it.
//
// The script carries its own helpers, in the way of KX's dbmaint.q, so what
// is reviewed is all that runs: nothing of q-lint's is assumed on the
// process. Each helper changes one table directory - its column files and
// its `.d` - and a directory where the change cannot be made (the column is
// missing, the new name taken) is left as it is and named in the answer; an
// error in one directory does not stop the others. The directories are the
// table's under every partition (`.Q.par`, so segments are followed), or
// the splayed table's under the root, which is where the process loaded the
// database from (`system "cd"`). The database is loaded again after, so the
// process sees what is now on disk. Under a `.Q.view` the partitions q lists
// are only those shown: changing them alone would leave the table with a
// column the others lack, so the script stops before its first change and
// says to clear the view (#1959).
//
// A symbol default is enumerated against the root's `sym` file, which it
// extends; a cast to `s` enumerates the same way. A string or symbol column
// cast to a number or time is parsed (`"J"$`), not cast char by char (#1135).
// Setting an attribute, or casting, reads the whole column of each partition and writes it back: the
// script's header says so. A rename moves the column's files with the
// shell's mv (move on Windows, its paths with backslashes), each path quoted
// for that shell (`.qlint.cm.mvcmd`, which takes the OS so both are tested
// anywhere, #1137): q has no
// rename of its own, and rewriting the column would read all of it. Works on kdb+ (KDB-X) and PeachQ; held there by
// dbtools_q.test.js.

import { symbolLiteral } from "./qliteral";

export type ColumnOp =
  | { op: "add"; column: string; value: string }
  | { op: "delete"; column: string }
  | { op: "rename"; column: string; to: string }
  | { op: "cast"; column: string; type: string }
  | { op: "attr"; column: string; attr: "" | "s" | "u" | "p" | "g" }
  | { op: "reorder"; order: string[] };

/// The types a column can be cast to, by q's type character.
export const CAST_TYPES = "bxhijefcspmdznuvt";

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/// Why `op` cannot be applied to a table of `columns` partitioned by
/// `field` (empty for a splayed one); undefined when it can.
export function opProblem(op: ColumnOp, columns: string[], field = ""): string | undefined {
  const has = (c: string) => columns.includes(c);
  if (op.op === "reorder") {
    const given = op.order.filter((c) => c !== field);
    const want = columns.filter((c) => c !== field);
    return given.length === want.length && want.every((c) => given.includes(c)) ? undefined : "a new order names every column once";
  }
  if (op.column === field && field !== "") {
    return `${field} is the partition field, which is not a column on disk`;
  }
  if (op.op === "add") {
    if (!NAME.test(op.column)) return `${op.column || "an empty name"} is not a column name q can use`;
    if (has(op.column)) return `the table already has a column ${op.column}`;
    if (op.value.trim() === "" || /[\r\n]/.test(op.value)) return "the default is one q value on one line: 0n, 0, `, \"\" or 0Np";
    return undefined;
  }
  if (!has(op.column)) return `the table has no column ${op.column}`;
  if (op.op === "rename") {
    if (!NAME.test(op.to)) return `${op.to || "an empty name"} is not a column name q can use`;
    if (has(op.to)) return `the table already has a column ${op.to}`;
    if (op.to === field) return `${op.to} is the partition field`;
  }
  if (op.op === "cast" && (op.type.length !== 1 || !CAST_TYPES.includes(op.type))) {
    return `cast to one of q's type characters: ${CAST_TYPES.split("").join(" ")}`;
  }
  return undefined;
}

/// What `op` does, in a few words.
export function opText(op: ColumnOp): string {
  switch (op.op) {
    case "add":
      return `add column ${op.column} (default ${op.value})`;
    case "delete":
      return `delete column ${op.column}`;
    case "rename":
      return `rename column ${op.column} to ${op.to}`;
    case "cast":
      return `cast column ${op.column} to "${op.type}"`;
    case "attr":
      return op.attr === "" ? `remove the attribute of column ${op.column}` : `set attribute ${op.attr}# on column ${op.column}`;
    case "reorder":
      return `reorder the columns: ${op.order.join(" ")}`;
  }
}

/// A name as a symbol: `` `a ``, or `` (`$"a b") `` for one a bare symbol
/// cannot write, parenthesised so it is one operand (#1569).
const sym = (name: string) => {
  const s = symbolLiteral(name);
  return s.startsWith("`$") ? `(${s})` : s;
};

/// The helper an op calls, applied to its arguments: a function of one
/// table directory.
function call(op: ColumnOp): string {
  switch (op.op) {
    case "add":
      return `.qlint.cm.add[${sym(op.column)};${op.value}]`;
    case "delete":
      return `.qlint.cm.del[${sym(op.column)}]`;
    case "rename":
      return `.qlint.cm.ren[${sym(op.column)};${sym(op.to)}]`;
    case "cast":
      return `.qlint.cm.cast[${sym(op.column)};"${op.type}"]`;
    case "attr":
      return `.qlint.cm.attr[${sym(op.column)};${op.attr === "" ? "`" : sym(op.attr)}]`;
    case "reorder":
      return `.qlint.cm.order[${op.order.length === 1 ? `enlist${sym(op.order[0])}` : op.order.every((c) => !sym(c).startsWith("(")) ? op.order.map(sym).join("") : `(${op.order.map(sym).join(";")})`}]`;
  }
}

/// The helpers, one a line: each takes its arguments and then a table
/// directory, and answers `ok`, or why it left the directory as it was.
export const HELPERS = [
  ".qlint.cm.cols:{[d] get ` sv d,`.d}",
  '.qlint.cm.enum:{$[11h=abs type x;(hsym`$system["cd"],"/sym")?x;x]}',
  '.qlint.cm.nested:{[c] c,`$string[c],/:("#";"##")}',
  ".qlint.cm.add:{[c;v;d] cs:.qlint.cm.cols d; if[c in cs;:`$\"has \",string c]; (` sv d,c) set count[get ` sv d,first cs]#enlist .qlint.cm.enum v; (` sv d,`.d) set cs,c; `ok}",
  ".qlint.cm.del:{[c;d] cs:.qlint.cm.cols d; if[not c in cs;:`$\"no \",string c]; {if[not ()~key x;hdel x]} each ` sv' d,/:.qlint.cm.nested c; (` sv d,`.d) set cs except c; `ok}",
  '.qlint.cm.mvcmd:{[w;a;b] p:$[w;{"\\"",ssr[x;"/";"\\\\"],"\\""};{"\'",ssr[x;"\'";"\'\\\\\'\'"],"\'"}]; $[w;"move ";"mv "],p[1_string a]," ",p 1_string b}',
  '.qlint.cm.mv:{[d;a;b] f:` sv d,a; if[not ()~key f; system .qlint.cm.mvcmd["w"=first string .z.o;f;` sv d,b]]}',
  ".qlint.cm.ren:{[o;n;d] cs:.qlint.cm.cols d; if[not o in cs;:`$\"no \",string o]; if[n in cs;:`$\"has \",string n]; .qlint.cm.mv[d]'[.qlint.cm.nested o;.qlint.cm.nested n]; (` sv d,`.d) set @[cs;cs?o;:;n]; `ok}",
  '.qlint.cm.cast:{[c;t;d] if[not c in .qlint.cm.cols d;:`$"no ",string c]; f:` sv d,c; v:get f; a:attr v; s:(0h=type v)|77h<=type v; y:(11h=abs type v)|type[v] within 20 76h; n:not t in "cs"; f set a#$["s"=t;.qlint.cm.enum $[s;`$v;`$string v];n&s;(upper t)$v;n&y;(upper t)$string v;t$v]; if[s&not "c"=t; {if[not ()~key x;hdel x]} each ` sv\' d,/:1_.qlint.cm.nested c]; `ok}',
  ".qlint.cm.attr:{[c;a;d] if[not c in .qlint.cm.cols d;:`$\"no \",string c]; f:` sv d,c; f set a#get f; `ok}",
  ".qlint.cm.order:{[o;d] cs:.qlint.cm.cols d; if[not (asc cs)~asc o;:`$\"other columns\"]; (` sv d,`.d) set o; `ok}",
  '.qlint.cm.dirs:{[t] r:hsym`$system"cd"; p:.Q.qp get t; if[1b~p; if[not .Q.pv~@[get;`.Q.PV;{.Q.pv}]; \'".Q.view is in force, showing ",string[count .Q.pv]," of ",string[count .Q.PV]," partitions: nothing was changed. This changes every partition on disk and loads the database again, which clears a view; clear it with .Q.view[] and run again"]]; $[1b~p;.Q.par[r;;t] each .Q.pv;0b~p;enlist ` sv r,t;\'"not a table on disk: ",string t]}',
  ".qlint.cm.run:{[t;f] d:.qlint.cm.dirs t; ([] dir:d; result:{[f;d] @[f;d;{`$\"error: \",x}]}[f] each d)}",
];

/// The script that applies `op` to every directory of table `table`, for
/// review: its helpers, the run, a reload of the database, and an answer
/// that says how many directories changed and what became of the others.
export function columnScript(table: string, op: ColumnOp, process: string): string {
  return columnScriptOf(table, [op], process, `${opText(op)} in ${table} on ${process}`);
}

/// The script that applies `ops`, one after another, to every directory of
/// `table`: a schema migration's (#1027). `what` heads it.
export function columnScriptOf(table: string, ops: ColumnOp[], process: string, what = `${ops.map(opText).join("; ")} in ${table} on ${process}`): string {
  const runs = ops.map((op, i) => `.qlint.cm.result,:update step:${i + 1} from .qlint.cm.run[${sym(table)};${call(op)}]`);
  return [
    `/ q-lint: HDB column manager - ${what}.`,
    "/ It changes every partition of the table on disk (or the splayed table under",
    "/ the root) and then loads the database again. Setting an attribute or casting",
    "/ reads and writes the whole column in each. Review it: it runs only when",
    "/ you choose Run, and the changes cannot be undone from here.",
    ...HELPERS,
    ".qlint.cm.result:([] dir:`$(); result:`$(); step:`long$())",
    ...runs,
    'system"l ."',
    '{r:.qlint.cm.result; delete cm from `.qlint; bad:select from r where result<>`ok; ("changed ",string[count[r]-count bad]," of ",string[count r]," directories"),$[count bad;"; left as they were: ",", "sv{(1_string x),": ",string y}\'[bad`dir;bad`result];""]}[]',
  ].join("\n");
}

/// Runs a script's statements in order and answers `(1b;last value)`, or
/// `(0b;error)` at the first that fails; either way the helpers are gone
/// after. The statements are the script's, as reviewed.
export const RUN_SCRIPT = "{[s] r:.[{(1b;last{value x}each x)};enlist s;{(0b;x)}]; @[{![`.qlint;();0b;enlist x]};`cm;::]; r}";

/// What `RUN_SCRIPT` answered: the script's answer, or why it stopped.
export function readRun(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "boolean") {
    throw new Error(`the process answered something other than the script's outcome: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const text = typeof raw[1] === "string" ? raw[1] : JSON.stringify(raw[1]);
  return raw[0] ? { ok: true, text } : { ok: false, error: text };
}
