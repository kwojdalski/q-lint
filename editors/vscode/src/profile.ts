// The function profile (#987): every function of one namespace timed over
// one run of a query, as cProfile times a Python program, for a sortable
// table and a flame chart (`profileview.ts`). Free of any `vscode` import,
// so node tests it.
//
// `PROFILE` is sent as one lambda with the namespace and the statements to
// run. It replaces each lambda directly in the namespace (`.ns.f`, not
// `.ns.sub.f`) with a wrapper of the same rank that notes the time, by q's
// own clock (`.z.p`), on entry and on exit - through an error too, which it
// signals on - runs the statements, and puts every original back, the very
// objects it took, whether the run succeeded or not - but for a name the
// run itself defined anew, which keeps its new definition. A wrapper holds
// its function's name written with `string`: `-3!` cuts a name longer than
// the process's `\c`, and the wrapper then called nothing (#1869). Its
// working state lives in `.qlint.prof` for the run and is deleted after. What it cannot see: a
// function reached by value rather than by name (one stored in a dictionary
// or a callback set before the run keeps the original), a projection or
// composition (only lambdas are wrapped), and a function of another
// namespace.
//
// The wrapper costs time on every call. Before the run the lambda times a
// thousand calls of `{x}` through a wrapper against a thousand direct ones,
// on that process, and answers the difference per call: about 1.7 µs on
// KDB-X and 4.8 µs on PeachQ on the machine this was written on. Each
// function's time includes the wrappers of the calls it makes, so a
// function that makes many short calls looks slower than it is by about
// that much a call; the view says how much in all. At most `LIMIT` calls
// are recorded, the first ones; the rest still run and are counted in the
// total time.

/// The most calls recorded in one run.
export const LIMIT = 100000;

export const PROFILE = [
  "{[ns;stmts]",
  " if[not (`$1_string ns) in key `; '\"not a namespace: \",string ns];",
  " d:get ns; if[99h<>type d; '\"not a namespace: \",string ns];",
  " f:k where 100h=type each d k:(key d) except `;",
  " full:` sv' ns,'f; orig:d f;",
  " .qlint.prof.log:([] id:`long$(); parent:`long$(); fn:`symbol$(); start:`timestamp$(); stop:`timestamp$());",
  " .qlint.prof.stack:enlist 0; .qlint.prof.n:0; .qlint.prof.orig:full!orig;",
  " .qlint.prof.call:{[name;args]",
  "   .qlint.prof.n+:1; id:.qlint.prof.n; p:last .qlint.prof.stack; .qlint.prof.stack,:id; t0:.z.p;",
  `   done:{[id;p;name;t0;u] .qlint.prof.stack:-1_.qlint.prof.stack; if[id<=${LIMIT}; \`.qlint.prof.log insert (id;p;name;t0;.z.p)]}[id;p;name;t0];`,
  "   r:.[.qlint.prof.orig name;args;{[done;e] done[]; 'e}[done]]; done[]; r};",
  " wrap:{[name;fn] ps:(value fn) 1; ps:$[ps~enlist `;enlist `x0;`$\"x\",/:string til count ps];",
  "   value \"{[\",(\";\" sv string ps),\"] .qlint.prof.call[`\",string[name],\";\",$[1=count ps;\"enlist \",string first ps;\"(\",(\";\" sv string ps),\")\"],\"]}\"};",
  " wrapped:wrap'[full;orig]; .qlint.prof.wrapped:full!wrapped;",
  " .qlint.prof.orig[`.qlint.prof.id]:{x}; idw:wrap[`.qlint.prof.id;{x}];",
  " t0:.z.p; do[1000;{x}1]; plain:.z.p-t0; t0:.z.p; do[1000;idw 1]; inst:.z.p-t0;",
  " .qlint.prof.log:0#.qlint.prof.log; .qlint.prof.n:0;",
  " t0:.z.p;",
  ' res:@[{[full;wrapped;stmts] full set\' wrapped; value each stmts; ""}[full;wrapped];stmts;{$[10h=type x;x;string x]}];',
  " total:.z.p-t0;",
  // Only a name still holding its wrapper is put back: one the run itself
  // defined anew keeps its new value (#1271).
  " {[n;w;o] if[w~@[get;n;{::}]; n set o]}'[full;wrapped;orig];",
  " l:.qlint.prof.log; n:.qlint.prof.n;",
  " (`float$total; `float$(inst-plain)%1000; res; `float$n; string full; `float$l`id; `float$l`parent; string l`fn; `float$l[`start]-t0; `float$l[`stop]-l`start)}",
].join("\n");

/// The cleanup that runs after `PROFILE`, whatever became of it: its
/// working state deleted, and the originals put back from it - where a
/// name still holds its wrapper - if the profile stopped between replacing
/// them and putting them back; a process that went away mid-run cannot be
/// helped.
export const PROFILE_CLEANUP = [
  "{[x]",
  " if[`prof in key `.qlint; if[99h=type w:.qlint.prof`wrapped; {[n;w;o] if[w~@[get;n;{::}]; n set o]}'[key w;value w;.qlint.prof.orig key w]]];",
  " @[{delete prof from `.qlint};::;::]; ::}",
].join("\n");

/// The names q keeps for itself: profiling them would wrap q's own code.
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
  /// ns a wrapped call costs over a plain one, measured on the process.
  overheadPerCall: number;
  /// The error the run stopped with, or empty.
  error: string;
  /// Calls made, recorded or not.
  calls: number;
  /// The functions wrapped.
  functions: string[];
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
  if (!Array.isArray(p) || p.length !== 10 || typeof p[0] !== "number" || typeof p[1] !== "number" || typeof p[2] !== "string" || typeof p[3] !== "number") {
    return bad();
  }
  // One function or one call answers an atom or a string where many answer
  // lists; none answer empty lists.
  const functions = Array.isArray(p[4]) && p[4].length === 0 ? [] : typeof p[4] === "string" ? [p[4]] : strings(p[4]);
  const ids = floats(p[5]) ?? [];
  const one = ids.length === 1;
  const parents = floats(p[6]) ?? [];
  const names = (one && typeof p[7] === "string" ? [p[7]] : Array.isArray(p[7]) && p[7].length === 0 ? [] : strings(p[7])) ?? bad();
  const starts = floats(p[8]) ?? [];
  const durations = floats(p[9]) ?? [];
  if (functions === undefined || [parents, names, starts, durations].some((l) => l.length !== ids.length)) {
    return bad();
  }
  return {
    namespace,
    total: p[0] as number,
    overheadPerCall: Math.max(0, p[1] as number),
    error: p[2] as string,
    calls: p[3] as number,
    functions,
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
  /// ns in the function itself, less the calls it made to wrapped ones.
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
    stats: functionStats(profile),
    frames: flame(profile),
  };
}
