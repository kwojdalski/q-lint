// The tickerplant log viewer (#1029): a tickerplant's log - the messages
// it journals, `(`upd;`trade;data)` each - read into a q of the
// extension's own, listed by message with its table, rows and first time,
// filtered by table and time of day, stepped through one message at a time,
// and a chosen range of messages replayed. Free of any `vscode` import, so
// node tests it; `tplogview.ts` starts the q and shows the page.
//
// Everything runs in a local q the extension starts for the log, listening
// on the loopback only: the log is never sent to, and nothing is replayed
// into, any process of yours. `-11!(-2;file)` counts the valid messages; a
// log whose end is cut short (a tickerplant that died mid-write) is read up
// to the last whole message - a copy of those bytes, its header's count
// set to theirs, in the local q's own directory - and the page says how
// many bytes were left. A message's time is its first temporal column's
// first item, or that column itself in a one-row message of atoms.
// A replay runs each message as `-11!` would, with an `upd` that inserts
// into a table of that name, creating it from a first message that is a
// table; a q file loaded first (the tickerplant's schema, its own `upd`)
// takes the place of that. Works on kdb+ (KDB-X) and PeachQ; held there by
// dbtools_q.test.js.

/// The local q's startup: the default `upd`, and the loader, pager and
/// replayer the page asks through.
export const TPLOG_INIT = [
  "upd:{[t;x] $[t in tables`.;t insert x;98h=type x;t set x;'\"no table \",string[t],\": load its schema first\"]}",
  ".qlint.tp.load:{[f] f:hsym`$f;c:-11!(-2;f);ok:0>type c;n:$[ok;c;c 0];",
  " m:$[0=n;();ok;get f;[b:(c 1)#read1 f;b[4+til 4]:reverse 0x0 vs\"i\"$n;p:`:qlintprefix.log;p 1:b;r:get p;hdel p;r]];",
  " m:(),m;",
  " d:{$[(0h=type x)&2<count x;x 2;::]}each m;",
  " tm:{tv:$[98h=type x;value flip x;0h=type x;x;()];tv:tv where(abs type each tv)within 12 19h;$[count tv;first first tv;0Np]}each d;",
  " .qlint.tp.m::m;",
  " .qlint.tp.s::([] i:til count m;",
  "  fn:{$[(0h=type x)&-11h=type first x;first x;`]}each m;",
  "  tb:{$[(0h=type x)&1<count x;$[-11h=type x 1;x 1;`];`]}each m;",
  "  rows:{\"f\"$$[98h=type x;count x;99h=type x;count x;0h=type x;$[count x;count first x;0];1]}each d;",
  "  tod:{$[null x;0n;\"f\"$`time$x]}each tm;",
  "  tx:{$[null x;\"\";string x]}each tm);",
  " `count`bytes`size`complete`tables!(\"f\"$n;\"f\"$$[ok;hcount f;c 1];\"f\"$hcount f;ok;string asc distinct exec tb from .qlint.tp.s where not null tb)}",
  ".qlint.tp.page:{[tn;t0;t1;off;lim] s:.qlint.tp.s;",
  " if[count tn;s:select from s where tb=`$tn];",
  " if[not null t0;s:select from s where tod>=t0];",
  " if[not null t1;s:select from s where tod<=t1];",
  " p:(\"j\"$lim)sublist(\"j\"$off)_s;",
  " `total`i`fn`tb`rows`tx!(\"f\"$count s;\"f\"$p`i;string p`fn;string p`tb;p`rows;p`tx)}",
  ".qlint.tp.show:{[i;w] .Q.S[(30;\"j\"$w);0j].qlint.tp.m\"j\"$i}",
  ".qlint.tp.replay:{[a;b] ix:(\"j\"$a)+til 1+(\"j\"$b)-\"j\"$a;",
  " r:{@[{value x;`ok};x;{`$x}]}each .qlint.tp.m ix;",
  " e:r where not r=`ok;",
  " `replayed`failed`errors`tables`rows!(\"f\"$count ix;\"f\"$count e;string 5 sublist distinct e;string tables`.;\"f\"${count get x}each tables`.)}",
].join("\n");

export interface TpLog {
  count: number;
  bytes: number;
  size: number;
  complete: boolean;
  tables: string[];
}

export interface TpPage {
  total: number;
  rows: { index: number; fn: string; table: string; rows: number; time: string }[];
}

export interface Replayed {
  replayed: number;
  failed: number;
  errors: string[];
  tables: { name: string; rows: number }[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null || s === undefined ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.map(number) : typeof v === "number" ? [v] : []);
const obj = (raw: unknown, key: string, what: string): Record<string, unknown> => {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !(key in r)) {
    throw new Error(`the local q answered something other than ${what}: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return r;
};

export function readTpLog(raw: unknown): TpLog {
  const r = obj(raw, "complete", "a log's summary");
  return { count: number(r.count), bytes: number(r.bytes), size: number(r.size), complete: r.complete === true, tables: strings(r.tables) };
}

export function readTpPage(raw: unknown): TpPage {
  const r = obj(raw, "total", "a page of messages");
  const index = numbers(r.i);
  // One row's strings come as strings, not lists of one.
  const one = index.length === 1;
  const fn = one ? [strings(r.fn).join("")] : strings(r.fn);
  const tb = one ? [strings(r.tb).join("")] : strings(r.tb);
  const tx = one ? [strings(r.tx).join("")] : strings(r.tx);
  const rows = numbers(r.rows);
  return { total: number(r.total), rows: index.map((i, k) => ({ index: i, fn: fn[k] ?? "", table: tb[k] ?? "", rows: rows[k] ?? 0, time: tx[k] ?? "" })) };
}

export function readReplayed(raw: unknown): Replayed {
  const r = obj(raw, "replayed", "a replay's outcome");
  const names = strings(r.tables);
  const rows = numbers(r.rows);
  return { replayed: number(r.replayed), failed: number(r.failed), errors: strings(r.errors), tables: names.map((name, i) => ({ name, rows: rows[i] ?? 0 })) };
}

/// A time of day typed as `HH:MM`, `HH:MM:SS` or `HH:MM:SS.mmm`, in ms
/// since midnight; null for an empty one; undefined for one that is not.
export function timeOfDay(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(t);
  if (!m || +m[1] > 23 || +m[2] > 59 || (m[3] !== undefined && +m[3] > 59)) return undefined;
  return ((+m[1] * 60 + +m[2]) * 60 + +(m[3] ?? 0)) * 1000 + +(m[4] ?? "0").padEnd(3, "0");
}

/// Why a range `from`..`to` of a log of `count` messages cannot be
/// replayed; undefined when it can.
export function rangeProblem(from: number, to: number, count: number): string | undefined {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return "a range is two message numbers";
  if (from < 0 || to >= count) return `the messages are numbered 0 to ${count - 1}`;
  if (from > to) return "the first message comes before the last";
  return undefined;
}
