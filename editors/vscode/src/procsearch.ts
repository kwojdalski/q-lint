// Find in processes (#1046), as data: one read-only lambda that searches
// every lambda's definition on a process for a piece of text - and, when
// asked, the names of its variables - and answers each line that has it.
// Free of any `vscode` import, so node tests it; `procsearchview.ts` runs
// it on every process with a tag and shows the hits as a tree.
//
// It walks the root and every namespace (not q's own: .q .Q .h .j .o .z,
// KDB-X's .s and .m (#2167), nor q-lint's .qlint), nested ones too, as Find Callers does, ignoring
// the case of A to Z: q's `lower` changes no other letter (#2166). The text is matched as written: `ss`'s wildcards `?` and `[` are
// escaped, so `x[1]?` finds just that; a text starting with a backtick,
// which the IPC client sends as a symbol, is made text again. At most
// `limit` hits are answered: one more is looked for, so `more` says only
// that there are more, not that the limit was reached (#1689).
// The lambdas are those named and those held in a projection, a composition
// or an iterator's derived function, or in a list or dictionary of at most
// 1000 items - a timer's projection, a table of handlers - as the dead code
// check reads them (#2544): a holder's hits are under its name, its lines
// counted through its lambdas' texts one after another.
// A view (`v::expr`) has a lambda's type, 100h, but no lambda's parts, and
// `get` of its name evaluates it: the root's views (`views[]`; q keeps
// them nowhere else) are neither searched nor counted (#1864).
// The lambda assigns nothing. Works on kdb+ (KDB-X) and PeachQ; held there
// by processtools_q.test.js.
import { isNumber, isString, listOf } from "./processtools";

export const SEARCH_LIMIT = 500;

export const SEARCH = [
  "{[pat;vars;lim]",
  " pat:lower$[-11h=type pat;\"`\",string pat;(),pat]; m:1+`long$lim;",
  " esc:raze{$[x in \"[]?*\";\"[\",x,\"]\";enlist x]}each pat;",
  " todo:`.,` sv'`,'asc(key`)except`q`Q`h`j`o`s`z`m`qlint`;",
  " todo:todo where{$[99h=type d:@[get;x;0];11h=type key d;0b]}each todo;",
  " lam:{$[100h=t:type x;enlist x;t within 104 111h;raze .z.s each(),value x;$[t in 0 99h;1000>=count x;0b];raze .z.s each $[99h=t;value x;x];()]};",
  " fns:`$();vn:`$();vw:views[];",
  " while[count todo;",
  "  ns:first todo;todo:1_todo;",
  "  d:@[get;ns;{()!()}];k:asc(key d)except`;",
  "  kids:$[ns~`.;`$();k where{$[99h=type x;$[11h=type key x;(::)~first x;0b];0b]}each d k];",
  "  todo,:` sv'ns,'kids;",
  "  full:$[ns~`.;k;` sv'ns,'k];t:type each d k;",
  "  j:where(not k in kids)&$[ns~`.;not k in vw;(count k)#1b];",
  "  fns,:full[j]where 0<count each@[lam;;()]each d k j;",
  "  vn,:full where not(t within 100 112h)|k in kids];",
  " nm:();kd:();ln:();tx:();",
  " i:0;while[(i<count fns)&m>count nm;",
  "  l:raze{\"\\n\" vs last value x}each lam get fns i;",
  "  w:where 0<count each(lower each l)ss\\:esc;",
  "  w:(m-count nm) sublist w;",
  "  nm,:(count w)#enlist string fns i;kd,:(count w)#`function;ln,:1+w;tx,:l w;",
  "  i+:1];",
  " if[vars;w:(m-count nm) sublist vn where 0<count each(lower each string vn)ss\\:esc;",
  "  nm,:string w;kd,:(count w)#`variable;ln,:(count w)#0;tx,:(count w)#enlist\"\"];",
  " c:m-1;(c sublist nm;string c sublist kd;\"f\"$c sublist ln;c sublist tx;\"f\"$count fns;m<=count nm)}",
].join("\n");

export interface Hit {
  /// The function's or variable's full name.
  name: string;
  kind: "function" | "variable";
  /// 1-based, within the function's definition; 0 for a variable.
  line: number;
  text: string;
}

export interface Found {
  hits: Hit[];
  /// Functions searched.
  scanned: number;
  /// Whether the limit cut the hits short.
  more: boolean;
}

/// What `SEARCH` answered. Throws when it is not that shape.
export function readFound(raw: unknown): Found {
  const p = raw as unknown[];
  const bad = (): never => {
    throw new Error(`the process answered something other than search hits: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  if (!Array.isArray(p) || p.length !== 6 || typeof p[4] !== "number" || typeof p[5] !== "boolean") {
    return bad();
  }
  const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
  const lines = empty(p[2]) ? [] : (listOf(p[2], isNumber) ?? bad());
  const one = lines.length === 1;
  const strings = (v: unknown): string[] => (empty(v) ? [] : one && isString(v) ? [v] : (listOf(v, isString) ?? bad()));
  const names = strings(p[0]);
  const kinds = strings(p[1]);
  const texts = strings(p[3]);
  if ([names, kinds, texts].some((l) => l.length !== lines.length) || kinds.some((k) => k !== "function" && k !== "variable")) {
    return bad();
  }
  return {
    hits: lines.map((line, i) => ({ name: names[i], kind: kinds[i] as Hit["kind"], line, text: texts[i] })),
    scanned: p[4],
    more: p[5],
  };
}

/// Why `text` cannot be searched for, or undefined.
export function patternProblem(text: string): string | undefined {
  return text.trim() === "" ? "type something to search for" : text.length > 200 ? "at most 200 characters" : undefined;
}

/// A process's hits, grouped by name, in the order found.
export function groupHits(hits: Hit[]): { name: string; kind: Hit["kind"]; hits: Hit[] }[] {
  const groups = new Map<string, { name: string; kind: Hit["kind"]; hits: Hit[] }>();
  for (const h of hits) {
    const key = `${h.kind} ${h.name}`;
    const g = groups.get(key) ?? { name: h.name, kind: h.kind, hits: [] };
    g.hits.push(h);
    groups.set(key, g);
  }
  return [...groups.values()];
}
