// Logpoints (#984), as data: what is sent to log a function's arguments on
// the process without editing its file, and to take the logging off again.
// Free of any `vscode` import, so node tests it; `logpointview.ts` is the
// VS Code around it.
//
// A logpoint replaces a function `f` on the process with its own text and
// one statement more, at the start of its body, as coverage instruments a
// function (`instrument.ts`): it prints the call's arguments with `0N!` -
// to the process's own console or log - and keeps the last 1000 calls, as
// one line of text each, in `.qlint.log.hits`. The function is otherwise
// itself: a call costs no frame of q's stack more, so a recursion as deep
// as q allows still runs (#2979), and a call it makes of itself through
// `.z.s` is logged too. What `f` held is kept in `.qlint.log.saved`. The
// keeping is trapped: where q refuses a global write - under `reval`, in a
// secondary thread of `peach` - the call is not kept and the function still
// answers (#1894). Removing it puts that back, unless `f` was redefined
// meanwhile, which is left as it is - and which is listed as having no
// logpoint, and takes a new one (#2558); when the last logpoint goes,
// `.qlint.log` goes too. `.qlint` itself stays, empty when nothing else of
// q-lint's is in it: q has no call that removes a context, and
// `delete qlint from`.` deletes the user's root variable of that name
// instead (#1871).
//
// The statement logs only while `.qlint.log` is there and lists the
// function: a reference taken while the logpoint is on - a handler, a
// timer - holds the text with the statement in it, and keeps answering,
// unlogged, once the logpoint is removed (#2974).
//
// The parameters are the function's own, so a call q refuses on a typed
// (`[x:`j]`) or pattern (`[(a;b)]`) parameter list is refused as before
// (#2406), and, never having started, is not logged.
//
// Only a lambda takes a logpoint. A projection or alias made of `f` before
// the logpoint keeps calling the original, unlogged.

import { codeMask, parameters, patternNames } from "./paramcache";
import { DRIFT, readDrift } from "./definitions";
import { REDEFINE } from "./funcsource";
import { DEFINE_AS, inserted, keepAndAssign, outer } from "./instrument";
import { FULL_TEXT } from "./qtext";

export const LOGPOINT_COMMANDS = {
  add: "q-lint.addLogpoint",
  remove: "q-lint.removeLogpoint",
  removeAll: "q-lint.removeAllLogpoints",
  hits: "q-lint.showLogpointHits",
} as const;

/// A name q-lint can write into q code as a symbol.
const GLOBAL = /^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

/// `text` (a lambda, the function `name`) made to log each call's
/// arguments at the start of its body, as the list a call gives them: one
/// item for each slot of its parameter list - a pattern slot as its names
/// make it up again - or its `x`, `y` and `z`.
export function logText(text: string, name: string): string | undefined {
  const mask = codeMask(text);
  const lambda = outer(text, mask);
  if (lambda === undefined || !GLOBAL.test(name)) {
    return undefined;
  }
  const item = (slot: string): string => {
    const names = patternNames(slot);
    return /^[A-Za-z][A-Za-z0-9_]*\s*(?::|$)/.test(slot) ? names[0] : !slot.includes(":") && !slot.includes("!") && !slot.includes("[") ? slot : names.length === 1 ? `enlist ${names[0]}` : `(${names.join(";")})`;
  };
  // A lambda that reads none of x, y and z still takes x.
  const args = lambda.slots !== undefined ? lambda.slots.filter((slot) => slot !== "").map(item) : ["x", ...parameters(text, lambda, mask).slice(1)];
  const list = args.length === 0 ? "enlist(::)" : args.length === 1 ? `enlist ${args[0]}` : `(${args.join(";")})`;
  return inserted(text, [{ offset: lambda.bodyStart, text: `$[\`log in key\`.qlint;.qlint.log.hit[\`${name};${list}];::];` }]);
}

/// Replaces the function named `nm` (a string), whose text on the process
/// is `was`, with `src` (`logText` of it), defined in its own context;
/// answers its name.
export const LOG_ADD = [
  "{[nm;was;src]",
  " nm:`$(),nm;f:@[get;nm;{::}];",
  " if[not 100h=type f;'\"not a lambda on the process\"];",
  // A name redefined since its logpoint has none any more: the stale entry
  // goes, and the new definition takes one (#2558).
  " i:@[get;`.qlint.log.inst;{(`$())!()}];",
  " if[nm in key i;if[i[nm]~f;'\"it has a logpoint already\"]];",
  " if[not((),was)~last value f;'\"it was redefined on the process meanwhile; add the logpoint again\"];",
  ` r:${DEFINE_AS}[f;(),src];`,
  " if[not first r;'last r];",
  " if[not`log in key`.qlint;.qlint.log.saved:(`$())!();.qlint.log.inst:(`$())!();.qlint.log.hits:()];",
  // `-3!` stops at the process's `\c` width, 79 characters (#2547).
  ` .qlint.log.text:${FULL_TEXT}[300];`,
  " .qlint.log.hit:{[nm;a]if[not nm in key .qlint.log.inst;:(::)];0N!(nm;a);@[{.qlint.log.hits:-1000 sublist .qlint.log.hits,enlist x};(.z.p;nm;300 sublist .qlint.log.text a);{}];};",
  ` r:last r;${keepAndAssign("log", "f", "r")}string nm}`,
].join("\n");

/// Adds a logpoint to `fn` on the process `call` sends to: reads the text
/// the process holds for it, and sends that back with the logging in it.
/// Answers the name; throws what the process refused it with.
export async function addLogpoint(call: (code: string, ...args: unknown[]) => Promise<unknown>, fn: string): Promise<string> {
  const state = readDrift(await call(DRIFT, fn)).get(fn);
  const src = state?.state === "lambda" ? logText(state.text, fn) : undefined;
  if (state === undefined || src === undefined) {
    throw new Error("not a lambda on the process");
  }
  // A run's own text in it goes when the run ends, and would take the
  // logpoint with it.
  if (state.via !== undefined && state.via !== "log") {
    throw new Error(`${VIA[state.via] ?? "q-lint"} holds it just now; add the logpoint when that is over`);
  }
  return String(await call(LOG_ADD, fn, state.text, src));
}

const VIA: Record<string, string> = { cov: "a coverage run", err: "a locals capture", prof: "a profile" };

/// Whether `nm` (a string) holds its logpoint now. Reads only.
export const LOG_HAS = "{[nm]nm:`$(),nm;i:@[get;`.qlint.log.inst;{(`$())!()}];$[nm in key i;i[nm]~@[get;nm;{::}];0b]}";

/// Redefines `name`, whose text on the process is `was`, as `text`
/// (`REDEFINE`), and puts its logpoint, when it had one, on the new
/// definition: the logpoint is in the old one's text, and went with it
/// (#2971). `had` says whether it had one, when the caller has read that
/// (`DRIFT`'s `via`); the process is asked otherwise. Answers what
/// `REDEFINE` did and, when the logpoint could not be put back, why.
export async function redefineKeepingLogpoint(
  call: (code: string, ...args: unknown[]) => Promise<unknown>,
  name: string,
  was: string,
  text: string,
  had?: boolean,
): Promise<{ held: unknown; lost?: string }> {
  had ??= (await call(LOG_HAS, name)) === true;
  const held = await call(REDEFINE, name, was, text);
  if (!had) {
    return { held };
  }
  try {
    await addLogpoint(call, name);
    return { held };
  } catch (error) {
    return { held, lost: error instanceof Error ? error.message : String(error) };
  }
}

/// Takes the logpoint off `nm` (a string); answers whether the function was
/// put back (false: it was redefined meanwhile, and is left as it is).
export const LOG_REMOVE = [
  "{[nm]",
  " nm:`$(),nm;o:@[get;`.qlint.log.saved;{(`$())!()}];",
  " if[not nm in key o;'\"it has no logpoint\"];",
  " back:.qlint.log.inst[nm]~@[get;nm;{::}];",
  " if[back;nm set o nm];",
  " .qlint.log.saved:(enlist nm)_o;.qlint.log.inst:(enlist nm)_.qlint.log.inst;",
  " if[0=count .qlint.log.saved;.qlint:(enlist`log)_.qlint];",
  " back}",
].join("\n");

/// An expression that reads, and changes nothing: the names with a
/// logpoint - those still holding the text with it, not one redefined since
/// (#2558) - and the calls kept, oldest first, as (time; name; arguments).
export const LOG_LIST = [
  "{[]",
  " if[not`log in key`.qlint;:`names`hits!(();())];",
  " n:{x where{.qlint.log.inst[x]~@[get;x;{::}]}each x}key .qlint.log.saved;",
  " `names`hits!(string n;{(string x 0;string x 1;x 2)}each .qlint.log.hits)}[]",
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
