// Logpoints (#984), as data: what is sent to log a function's arguments on
// the process without editing its file, and to take the logging off again.
// Free of any `vscode` import, so node tests it; `logpointview.ts` is the
// VS Code around it.
//
// A logpoint replaces a function `f` on the process with a wrapper of the
// same parameters that prints the call's arguments with `0N!` - to the
// process's own console or log - keeps the last 1000 calls, as one line of
// text each, in `.qlint.log.hits`, and then calls the function it replaced,
// kept in `.qlint.log.orig`. The keeping is trapped: where q refuses a
// global write - under `reval`, in a secondary thread of `peach` - the call
// is not kept and the function still answers (#1894). Removing it puts that back, unless `f` was
// redefined meanwhile, which is left as it is; when the last logpoint goes,
// `.qlint.log` goes too. `.qlint` itself stays, empty when nothing else of
// q-lint's is in it: q has no call that removes a context, and
// `delete qlint from`.` deletes the user's root variable of that name
// instead (#1871).
//
// Only a lambda takes a logpoint. A projection or alias made of `f` before
// the logpoint keeps calling the original, unlogged.

export const LOGPOINT_COMMANDS = {
  add: "q-lint.addLogpoint",
  remove: "q-lint.removeLogpoint",
  removeAll: "q-lint.removeAllLogpoints",
  hits: "q-lint.showLogpointHits",
} as const;

/// Wraps the function named `nm` (a string); answers its name.
export const LOG_ADD = [
  "{[nm]",
  " nm:`$(),nm;f:@[get;nm;{::}];",
  " if[not 100h=type f;'\"not a lambda on the process\"];",
  " if[nm in key@[get;`.qlint.log.orig;{(`$())!()}];'\"it has a logpoint already\"];",
  " p:(value f)1;if[p~enlist`;p:`$()];",
  " s:\";\"sv string p;a:$[0=count p;\"enlist(::)\";1=count p;\"enlist \",s;\"(\",s,\")\"];n:\"`\",string nm;",
  " w:value\"{[\",s,\"] 0N!(\",n,\";\",a,\");@[{.qlint.log.hits:-1000 sublist .qlint.log.hits,enlist x};(.z.p;\",n,\";300 sublist -3!\",a,\");{}];.qlint.log.orig[\",n,\"] . \",a,\"}\";",
  " if[not`log in key`.qlint;.qlint.log.orig:(`$())!();.qlint.log.wrap:(`$())!();.qlint.log.hits:()];",
  " .qlint.log.orig[nm]:f;.qlint.log.wrap[nm]:w;",
  " nm set w;string nm}",
].join("\n");

/// Takes the logpoint off `nm` (a string); answers whether the function was
/// put back (false: it was redefined meanwhile, and is left as it is).
export const LOG_REMOVE = [
  "{[nm]",
  " nm:`$(),nm;o:@[get;`.qlint.log.orig;{(`$())!()}];",
  " if[not nm in key o;'\"it has no logpoint\"];",
  " back:.qlint.log.wrap[nm]~@[get;nm;{::}];",
  " if[back;nm set o nm];",
  " .qlint.log.orig:(enlist nm)_o;.qlint.log.wrap:(enlist nm)_.qlint.log.wrap;",
  " if[0=count .qlint.log.orig;.qlint:(enlist`log)_.qlint];",
  " back}",
].join("\n");

/// An expression that reads, and changes nothing: the names with a
/// logpoint, and the calls kept, oldest first, as (time; name; arguments).
export const LOG_LIST = [
  "{[]",
  " if[not`log in key`.qlint;:`names`hits!(();())];",
  " `names`hits!(string key .qlint.log.orig;{(string x 0;string x 1;x 2)}each .qlint.log.hits)}[]",
].join("\n");

export interface Hit {
  time: string;
  name: string;
  args: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.join("") : String(v ?? ""));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/// What `LOG_LIST` answered.
export function readLogpoints(raw: unknown): { names: string[]; hits: Hit[] } {
  const r = raw as { names?: unknown; hits?: unknown } | null;
  if (r === null || typeof r !== "object" || !("names" in r)) {
    throw new Error(`the process answered something other than its logpoints: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  // One name arrives as a string, several as a list of them.
  const names = typeof r.names === "string" ? [r.names] : list(r.names).map(text);
  const hits = list(r.hits)
    .filter((h): h is unknown[] => Array.isArray(h) && h.length === 3)
    .map(([time, name, args]) => ({ time: text(time), name: text(name), args: text(args) }));
  return { names, hits };
}

/// The lines **Show Logpoint Hits** shows.
export function hitLines(process: string, hits: Hit[]): string[] {
  if (hits.length === 0) {
    return [`# ${process}: no logpoint has been hit`];
  }
  return [`# ${process}: the last ${hits.length} logpoint hit${hits.length === 1 ? "" : "s"}, oldest first`, ...hits.map((h) => `${h.time} ${h.name} ${h.args}`)];
}
