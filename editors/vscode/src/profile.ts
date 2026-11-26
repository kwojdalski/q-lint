// The function profile (#987): every function of one namespace timed over
// one run of a query, as cProfile times a Python program, for a sortable
// table and a flame chart (`profileview.ts`). Free of any `vscode` import,
// so node tests it.
//
// The timing is written into each function's own text, as coverage's probes
// are (`instrument.ts`): `PROFILE_READ` answers the text of each lambda
// directly in the namespace (`.ns.f`, not `.ns.sub.f`), `profileText` puts
// into it a note of the time, by q's own clock (`.z.p`), where the body
// starts and wherever the text hands a value back or signals, and `PROFILE`
// defines each anew in its own context, runs the statements, and puts every
// original back, the very objects it took, whether the run succeeded or not
// - but for a name the run itself defined anew, which keeps its new
// definition and is answered as kept, for the view to say so (#2980). A
// function timed this way is still one function: a call of
// it adds no frame to q's stack, so a recursion as deep as q allows still
// runs (#2978), and `.z.s` inside it is the timed function, so a recursion
// through `.z.s` is counted call by call (#2977). Its working state lives
// in `.qlint.prof` for the run and is deleted after; the timing asks
// whether it is there before it notes anything, so a reference the run
// took to a timed function - a callback it registered, `.z.ts` - goes on
// answering once the profile is over (#2973). What it cannot see: a
// function reached by a reference taken before the run (one stored in a
// dictionary or a callback keeps the original), a projection or
// composition (only lambdas are timed), a function of another namespace,
// and where a call ended when an error q itself signalled ended it: such a
// call is closed when a caller of it that is timed returns, or the run
// ends, and until then a call made after it is shown under it.
//
// The timing costs time on every call. Before the run the lambda times a
// thousand calls of `{x}` timed against a thousand plain ones, on that
// process, and answers the difference per call: about 1 µs on KDB-X on the
// machine this was written on. Each function's time includes the timing of
// the calls it makes, so a function that makes many short calls looks
// slower than it is by about that much a call; the view says how much in
// all. At most `LIMIT` calls are recorded, the first ones; the rest still
// run and are counted in the total time.

import { DEFINE_AS, bodyStatements, exits, inserted, outer } from "./instrument";
import { codeMask } from "./paramcache";

/// The most calls recorded in one run.
export const LIMIT = 100000;

const GLOBAL = /^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

/// `text` (a lambda, the function `name`) made to note when each call of
/// it starts and ends: `qlintprof` is what closes the call, applied to the
/// value the text hands back or signals, and is the identity when no
/// profile is running. Undefined when the text is not one lambda.
export function profileText(text: string, name: string): string | undefined {
  const mask = codeMask(text);
  const lambda = outer(text, mask);
  if (lambda === undefined || !GLOBAL.test(name)) {
    return undefined;
  }
  return inserted(text, [
    { offset: lambda.bodyStart, text: `qlintprof:$[\`prof in key\`.qlint;.qlint.prof.in\`${name};::];` },
    ...exits(text, lambda, mask, bodyStatements(text, lambda, mask), "qlintprof", true),
  ]);
}

const NAMESPACE = [
  " if[not (`$1_string ns) in key `; '\"not a namespace: \",string ns];",
  " d:get ns; if[99h<>type d; '\"not a namespace: \",string ns];",
].join("\n");

/// Answers the lambdas directly in the namespace `ns` (a symbol), their
/// full names and their texts. Reads only.
export const PROFILE_READ = [
  "{[ns]",
  NAMESPACE,
  " f:k where 100h=type each d k:(key d) except `;",
  " `name`text!(string ` sv' ns,'f; {last value x} each d f)}",
].join("\n");

/// Replaces each of `nms` (strings) whose text on the process is `was` with
/// `src` (`profileText` of it; one that is no lambda leaves the function as
/// it is, untimed), runs `stmts`, and puts back what it replaced. The log
/// is one list, three items a note: a call's number, its function and the
/// time where it starts, and its number, the null symbol and the time where
/// it ends. The calls are made up from it after the run: one that ended
/// unseen is closed with the first caller of it seen to end, or with the
/// run.
export const PROFILE = [
  "{[ns;nms;was;src;stmts]",
  NAMESPACE,
  " .qlint.prof.n:0; .qlint.prof.log:(); .qlint.prof.saved:(`$())!(); .qlint.prof.inst:(`$())!();",
  ` .qlint.prof.in:{[nm] id:.qlint.prof.n+:1; if[id>${LIMIT}; :(::)]; .qlint.prof.log,:(id;nm;.z.p); .qlint.prof.out id};`,
  " .qlint.prof.out:{[id;r] .qlint.prof.log,:(id;`;.z.p); r};",
  ` idw:${profileText("{x}", ".qlint.prof.id")};`,
  " t0:.z.p; do[1000;{x}1]; plain:.z.p-t0; t0:.z.p; do[1000;idw 1]; inst:.z.p-t0;",
  " .qlint.prof.n:0; .qlint.prof.log:();",
  " nms:`${(),x}each(),nms;",
  " {[nm;w;s] old:@[get;nm;{::}];",
  "   if[not 100h=type old; :(::)]; if[not w~last value old; :(::)];",
  `   r:${DEFINE_AS}[old;s]; if[not first r; :(::)]; if[not 100h=type last r; :(::)];`,
  // Kept by amending: assigned, a function with no name yet would take
  // `.qlint.prof.saved` for one, and show it in a backtrace (#2970).
  "   @[`.qlint.prof.saved;nm;:;old]; @[`.qlint.prof.inst;nm;:;last r];}'[nms;{(),x}each(),was;{(),x}each(),src];",
  " full:key .qlint.prof.saved; timed:.qlint.prof.inst full; orig:value .qlint.prof.saved;",
  " t0:.z.p;",
  // Each is assigned as a script assigns it, so that a backtrace of the run
  // names it; `set` names nothing (#2970).
  ' res:@[{[full;timed;stmts] {[n;f] .[{eval(:;x;y)};(n;f);{}]; n set f}\'[full;timed]; value each stmts; ""}[full;timed];stmts;{$[10h=type x;x;string x]}];',
  " t1:.z.p;",
  // Only a name still holding its timed text is put back: one the run
  // itself defined anew keeps its new value (#1271), and is answered as
  // kept, so that the view does not say it was put back (#2980).
  " kept:full where not {[n;w;o] $[w~@[get;n;{::}]; [n set o; 1b]; 0b]}'[full;timed;orig];",
  " c:{[l;t1] m:(count l) div 3; id:`long$l 3*til m; fn:`$string l 1+3*til m; t:`timestamp$l 2+3*til m;",
  "   e:where not null fn; par:(count e)#0; stop:(count e)#t1; st:enlist 0; i:0;",
  "   do[m; $[null fn i; [p:st?id i; if[p<count st; stop[-1+p _ st]:t i; st:p#st]]; [par[-1+id i]:last st; st,:id i]]; i+:1];",
  "   (par;fn e;t e;stop)}[.qlint.prof.log;t1];",
  " (`float$t1-t0; `float$(inst-plain)%1000; res; `float$.qlint.prof.n; string full; `float$1+til count c 0; `float$c 0; string c 1; `float$c[2]-t0; `float$c[3]-c 2;",
  "  string nms except full; string kept)}",
].join("\n");

/// The cleanup that runs after `PROFILE`, whatever became of it: its
/// working state deleted, and the originals put back from it - where a
/// name still holds its timed text - if the profile stopped between
/// replacing them and putting them back; a process that went away mid-run
/// cannot be helped.
export const PROFILE_CLEANUP = [
  "{[x]",
  " if[`prof in key `.qlint; if[99h=type w:.qlint.prof`inst; {[n;w;o] if[w~@[get;n;{::}]; n set o]}'[key w;value w;.qlint.prof.saved key w]]];",
  " @[{delete prof from `.qlint};::;::]; ::}",
].join("\n");

/// Profiles the namespace `ns` over `stmts` on the process `call` sends
/// to: reads its functions, and sends them back with the timing in their
/// text. Answers what `PROFILE` answered, for `readProfile`.
export async function runProfile(call: (code: string, ...args: unknown[]) => Promise<unknown>, ns: string, stmts: string[]): Promise<unknown> {
  const read = (await call(PROFILE_READ, `\`${ns}`)) as { name?: unknown; text?: unknown } | null;
  if (read === null || typeof read !== "object" || read.name === undefined || read.text === undefined) {
    throw new Error(`the process answered something other than its functions: ${JSON.stringify(read)?.slice(0, 200)}`);
  }
  const names = list(read.name).map(String);
  const texts = list(read.text).map(String);
  // One that cannot be given the timing goes as no text, and is answered
  // as not timed.
  return call(PROFILE, `\`${ns}`, names, texts, names.map((name, i) => profileText(texts[i] ?? "", name) ?? ""), stmts);
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/// The names q keeps for itself: profiling them would replace q's own code.
const RESERVED = new Set([".q", ".Q", ".h", ".j", ".o", ".z", ".qlint"]);

/// Why `namespace` cannot be profiled, or undefined when it can: a dotted
/// name of one or more parts, not q's own.
export function namespaceProblem(namespace: string): string | undefined {
  const ns = namespace.trim();
  if (!/^\.[A-Za-z][A-Za-z0-9_]*$/.test(ns)) {
    return "a namespace is a dot and a name, as .lib: a top-level one, whose functions are .lib.f";
  }
  if (RESERVED.has(ns)) {
    return `${ns} is q's or q-lint's own`;
  }
  return undefined;
}

/// One call recorded.
export interface Call {
  id: number;
  parent: number;
  fn: string;
  /// ns from the start of the run.
  start: number;
  /// ns.
  duration: number;
}

export interface Profile {
  namespace: string;
  /// ns, the whole run.
  total: number;
  /// ns a timed call costs over a plain one, measured on the process.
  overheadPerCall: number;
  /// The error the run stopped with, or empty.
  error: string;
  /// Calls made, recorded or not.
  calls: number;
  /// The functions timed.
  functions: string[];
  /// The lambdas of the namespace left as they were, not timed: their text
  /// could not be given the timing.
  untimed: string[];
  /// The functions not put back: the run itself defined them anew, or
  /// deleted them, and they are as it left them (#1271).
  kept: string[];
  recorded: Call[];
}

const floats = (v: unknown): number[] | undefined => {
  const list = Array.isArray(v) ? v : typeof v === "number" ? [v] : undefined;
  return list?.every((n) => typeof n === "number") ? (list as number[]) : undefined;
};
const strings = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : undefined;
  return list?.every((n) => typeof n === "string") ? (list as string[]) : undefined;
};

/// What `PROFILE` answered. Throws when it is not that shape.
export function readProfile(raw: unknown, namespace: string): Profile {
  const p = raw as unknown[];
  const bad = (): never => {
    throw new Error(`the process answered something other than a profile: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  if (!Array.isArray(p) || p.length !== 12 || typeof p[0] !== "number" || typeof p[1] !== "number" || typeof p[2] !== "string" || typeof p[3] !== "number") {
    return bad();
  }
  // One function or one call answers an atom or a string where many answer
  // lists; none answer empty lists.
  const named = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length === 0 ? [] : typeof v === "string" ? [v] : strings(v));
  const functions = named(p[4]);
  const ids = floats(p[5]) ?? [];
  const one = ids.length === 1;
  const parents = floats(p[6]) ?? [];
  const names = (one && typeof p[7] === "string" ? [p[7]] : Array.isArray(p[7]) && p[7].length === 0 ? [] : strings(p[7])) ?? bad();
  const starts = floats(p[8]) ?? [];
  const durations = floats(p[9]) ?? [];
  const untimed = named(p[10]);
  const kept = named(p[11]);
  if (functions === undefined || untimed === undefined || kept === undefined || [parents, names, starts, durations].some((l) => l.length !== ids.length)) {
    return bad();
  }
  return {
    namespace,
    total: p[0] as number,
    overheadPerCall: Math.max(0, p[1] as number),
    error: p[2] as string,
    calls: p[3] as number,
    functions,
    untimed,
    kept,
    recorded: ids.map((id, i) => ({ id, parent: parents[i], fn: names[i], start: starts[i], duration: durations[i] })),
  };
}

/// A function's line of the table.
export interface FunctionStats {
  fn: string;
  calls: number;
  /// ns in the function and what it called; a recursive call is counted
  /// once, at its outermost.
  total: number;
  /// ns in the function itself, less the calls it made to timed ones.
  self: number;
  /// ns per call, of `total`.
  mean: number;
  max: number;
}

/// The table: one line for each function called, slowest total first.
export function functionStats(profile: Profile): FunctionStats[] {
  const byId = new Map(profile.recorded.map((c) => [c.id, c]));
  const children = new Map<number, number>();
  for (const c of profile.recorded) {
    children.set(c.parent, (children.get(c.parent) ?? 0) + c.duration);
  }
  const stats = new Map<string, FunctionStats>();
  for (const c of profile.recorded) {
    const s = stats.get(c.fn) ?? { fn: c.fn, calls: 0, total: 0, self: 0, mean: 0, max: 0 };
    s.calls++;
    s.self += Math.max(0, c.duration - (children.get(c.id) ?? 0));
    s.max = Math.max(s.max, c.duration);
    // Inside a call of itself, it is already counted.
    let up = byId.get(c.parent);
    let nested = false;
    while (up !== undefined && !nested) {
      nested = up.fn === c.fn;
      up = byId.get(up.parent);
    }
    if (!nested) {
      s.total += c.duration;
    }
    stats.set(c.fn, s);
  }
  for (const s of stats.values()) {
    s.mean = s.calls === 0 ? 0 : s.total / s.calls;
  }
  return [...stats.values()].sort((a, b) => b.total - a.total || a.fn.localeCompare(b.fn));
}

/// A frame of the flame chart: the calls of one function by one path of
/// callers, merged, as snakeviz merges them.
export interface Frame {
  fn: string;
  /// ns, all of the merged calls.
  duration: number;
  calls: number;
  /// Depth from the run, 0 at the top.
  depth: number;
  /// ns from the left of the chart, of the frames before it at its depth
  /// under the same parent.
  offset: number;
}

/// The flame chart: one frame per path of callers, widest first under each
/// parent, laid out left to right.
export function flame(profile: Profile): Frame[] {
  interface Node {
    fn: string;
    duration: number;
    calls: number;
    children: Map<string, Node>;
  }
  const root: Node = { fn: "", duration: 0, calls: 0, children: new Map() };
  const nodeOf = new Map<number, Node>([[0, root]]);
  // Parents end after their children, so are recorded after them: walk by id,
  // the order the calls began in.
  for (const c of [...profile.recorded].sort((a, b) => a.id - b.id)) {
    const parent = nodeOf.get(c.parent) ?? root;
    let node = parent.children.get(c.fn);
    if (node === undefined) {
      node = { fn: c.fn, duration: 0, calls: 0, children: new Map() };
      parent.children.set(c.fn, node);
    }
    node.duration += c.duration;
    node.calls++;
    nodeOf.set(c.id, node);
  }
  const frames: Frame[] = [];
  const lay = (node: Node, depth: number, offset: number): void => {
    let at = offset;
    for (const child of [...node.children.values()].sort((a, b) => b.duration - a.duration || a.fn.localeCompare(b.fn))) {
      frames.push({ fn: child.fn, duration: child.duration, calls: child.calls, depth, offset: at });
      lay(child, depth + 1, at);
      at += child.duration;
    }
  };
  lay(root, 0, 0);
  return frames;
}

/// What the view is sent: the profile digested.
export interface ProfileView {
  namespace: string;
  process: string;
  code: string;
  total: number;
  overheadPerCall: number;
  /// The overhead in all: per call, by the calls made.
  overheadTotal: number;
  error: string;
  calls: number;
  recorded: number;
  functions: number;
  untimed: string[];
  kept: string[];
  stats: FunctionStats[];
  frames: Frame[];
}

export function profileView(profile: Profile, process: string, code: string): ProfileView {
  return {
    namespace: profile.namespace,
    process,
    code,
    total: profile.total,
    overheadPerCall: profile.overheadPerCall,
    overheadTotal: profile.overheadPerCall * profile.calls,
    error: profile.error,
    calls: profile.calls,
    recorded: profile.recorded.length,
    functions: profile.functions.length,
    untimed: profile.untimed,
    kept: profile.kept,
    stats: functionStats(profile),
    frames: flame(profile),
  };
}
