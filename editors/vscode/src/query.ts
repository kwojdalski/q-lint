// What a query sends a q process, and how its answer is read.
//
// The process is sent one lambda with each query and keeps nothing: no
// helper is defined on it, so connecting to a production process changes
// nothing there but what the user's own code changes. The lambda runs the
// statements in order with `value` - in the process's current `\d`, as its
// console would - and answers with a dictionary:
//
//   success  `ok`type`text!(1b; type of the last value; .Q.S lines)
//   failure  `ok`error`trace!(0b; q's error; its backtrace, or "")
//
// The text is formatted by the process itself, at the console size asked
// for, so a large result is cut there rather than sent whole. The size
// arrives as floats - a JavaScript number is sent as one - and is made long
// there: kdb+'s `.Q.S` takes floats, PeachQ's refuses them with 'type.
//
// The backtrace needs `.Q.trp` (kdb+ 3.5 and later); without it an error has
// no trace. The last four frames of one are this lambda's own (itself,
// `.Q.trp`, the runner and `each`) and are dropped.

/// The lines that run the statements `s` into `r`: `(1b; last value)` or
/// `(0b; error; trace)`. `grid.ts`'s lambda runs them the same way, from a
/// lambda as deep, so the four frames dropped are its own there too.
///
/// `readOnly`: each statement is evaluated under `reval` instead, which
/// refuses, with q's own error, what would change the process - a global
/// assigned, a file written or deleted, a handle to a file opened, a system
/// command that sets something or runs a shell. Reads run as they would,
/// and `\d` in a statement holds for the statements after it, as under
/// `value`. It is the read-only guard's backstop: code the guard reads as
/// read-only goes to a guarded process this way, so a write the guard
/// missed is a q error, not a change. A process without `reval` answers
/// `NO_REVAL` having run nothing. A trace drops one frame more, the
/// evaluator's.
export function trapLines(readOnly = false): string[] {
  const each = readOnly ? "last{reval(value;x)}each x" : "last value each x";
  return [
    ` r:$[${readOnly ? `not\`reval in key\`.q;(0b;"${NO_REVAL}";"");` : ""}\`trp in key \`.Q;`,
    `   .Q.trp[{(1b;${each})};s;{(0b;x;.Q.sbt ${readOnly ? -5 : -4}_y)}];`,
    `   @[{(1b;${each})};s;{(0b;x;"")}]];`,
  ];
}

/// What a `readOnly` lambda answers as its error on a process without
/// `reval`, having run nothing: no q error reads so.
export const NO_REVAL = "q-lint: this process has no reval";

export const TRAP = trapLines();

/// How a lambda that does not run its statements through `trapLines` -
/// one that times them, prints them as JSON, explains an aj over them -
/// evaluates the user's code: `value` and `system`, or their `reval`
/// twins, the read-only guard's backstop. Spliced into the lambda's text
/// where it would write `value` or `system`, applied to a string.
export interface Evaluate {
  value: string;
  system: string;
}

/// `value` and `system` as they are.
export const EVALUATE: Evaluate = { value: "value", system: "system" };
/// Under `reval`: a write the code would make is a q error (`refusedByReval`).
export const EVALUATE_READ_ONLY: Evaluate = { value: "{reval(value;x)}", system: "{reval(system;x)}" };

/// `.Q.S[size;0j]` of a value, trapped: q-lint's lambda is a few frames
/// deeper than the console, so a value nested about 1000 deep raises
/// 'stack there, after the statements ran - then `-3!` writes it, and
/// failing that, a line says so (#2651). Applied to the size and the value.
export const LAID_TEXT = "{[size;v]@[.Q.S[\"j\"$size;0j];v;{[v;e]@[{enlist -3!x};v;{enlist\"q-lint: the value could not be laid out: '\",x}]}[v]]}";

/// What `RUN` answers when a statement failed (`r`, as `trapLines` leaves
/// it): the error, its trace, and the `\d` the process is in, which is where
/// the statements that ran left it - nothing puts it back before the query
/// ends (#2913).
export const FAILED = '`ok`error`trace`context!(0b;r 1;r 2;string system"d")';

/// `RUN`, its statements evaluated under `reval` when `readOnly`.
function runLambda(readOnly: boolean): string {
  return [
    "{[s;size]",
    ...trapLines(readOnly),
    " $[r 0;",
    `   \`ok\`type\`text!(1b;type r 1;${LAID_TEXT}[size;r 1]);`,
    `   ${FAILED}]}`,
  ].join("\n");
}

export const RUN = runLambda(false);
/// `RUN` under `reval`.
export const RUN_READ_ONLY = runLambda(true);

/// Whether `error`, from a statement evaluated under `reval`, is `reval`
/// refusing it: a global it would assign (`noupdate`), a file or a handle
/// (`access`), a system command (`sys`), a message to handle 0 or to the
/// process itself (`restricted`). Reads that change something on the way
/// are refused so too: a function that caches into a global, the first
/// `.Q.ind` on a partitioned table, which sets `.Q.PN`.
export function refusedByReval(error: string): boolean {
  return /^(noupdate|access)\b/.test(error) || error === "sys" || error === "restricted";
}

/// The trap whose own frame tops `trace`, a failure's backtrace as
/// `trapLines` answers it, when the error was raised there: `.Q.trp` or
/// `.Q.trpd` (`  [6]  (.Q.trp)`), or `-105!` with the caret at its `!` -
/// not `a-105!x`, a subtraction.
/// Undefined otherwise.
function trapAtTop(trace: string): string | undefined {
  const [frame, caret] = trace.split("\n");
  const at = /^\s*\[\d+\]\s+/.exec(frame ?? "");
  if (at === null) {
    return undefined;
  }
  const text = frame.slice(at[0].length);
  const named = /^\((\.Q\.trpd?)\)\s*$/.exec(text);
  if (named !== null) {
    return named[1];
  }
  const col = caret === undefined ? -1 : caret.indexOf("^") - at[0].length;
  return col >= 4 && text[col] === "!" && /(^|[^\w.)\]}])-105\s*$/.test(text.slice(0, col)) ? "-105!" : undefined;
}

/// What `reval` refused, from a statement's failure under it - its
/// `error` and backtrace `trace` - or undefined for an error it did not
/// cause: q's own refusal (`refusedByReval`), or an error raised by a trap
/// in the code - `.Q.trp`, `.Q.trpd`, `-105!` - where it applied the code's
/// handler (#3170). Such a trap catches `reval`'s refusal and gives its
/// handler the error and the backtrace, so a handler of the wrong kind
/// fails there - `::` with `'type`, `{x}` with `'rank` - where sent
/// directly the code runs and the handler is never called. The trap cannot
/// say what it caught, so a handler failing on an error of the code's own
/// is taken for a refusal too: confirmed, it is sent once as it is and
/// fails there the same way. The error is said as q raised it, with where.
/// An error raised anywhere else - by code with no such trap - is the
/// code's own and no refusal.
export function revalRefusal(error: string, trace = ""): string | undefined {
  if (refusedByReval(error)) {
    return error;
  }
  const trap = trapAtTop(trace);
  return trap === undefined ? undefined : `${error}, raised where ${trap} called the code's handler, as it does with what reval refuses`;
}

export type Answer =
  | { ok: true; type: number; text: string[] }
  | { ok: false; error: string; trace: string; context?: string };

/// The answer `RUN` gave, read from what the IPC client made of it. Throws
/// when it is not one: a process that redefines `.Q.S` or `value` could
/// answer anything.
export function readAnswer(raw: unknown): Answer {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.ok !== "boolean") {
    throw new Error(`the process answered something other than a query result: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  if (r.ok) {
    const text = Array.isArray(r.text) ? r.text.map(String) : typeof r.text === "string" ? [r.text] : [];
    return { ok: true, type: typeof r.type === "number" ? r.type : 0, text };
  }
  return {
    ok: false,
    error: typeof r.error === "string" ? r.error : String(r.error),
    trace: typeof r.trace === "string" ? r.trace : "",
    ...(typeof r.context === "string" ? { context: r.context } : {}),
  };
}

/// q's generic null, `(::)`: what an assignment ending in `;` gives.
export const NULL_TYPE = 101;

export interface Shown {
  /// The process's label.
  process: string;
  code: string;
  answer: Answer;
  millis: number;
}

/// The lines the output channel shows for one query: a header naming the
/// process, the time taken and the outcome, the code when `includeQuery`
/// asks for it, then the result text or the error and its trace. Empty when
/// `ignoreNullReturn` is set and the answer is q's generic null.
export function render(shown: Shown, options: { includeQuery: boolean; ignoreNullReturn: boolean }): string[] {
  const { answer } = shown;
  if (options.ignoreNullReturn && answer.ok && answer.type === NULL_TYPE) {
    return [];
  }
  const outcome = answer.ok ? "" : ` - '${answer.error}`;
  const lines = [`# ${shown.process} (${shown.millis} ms)${outcome}`];
  // One push per line, never push(...many): an unlimited result is one line
  // per row, and V8 refuses a spread of 150k+ arguments.
  const add = (more: readonly string[]) => {
    for (const l of more) {
      lines.push(l);
    }
  };
  if (options.includeQuery) {
    add(shown.code.split("\n").map((l) => `q) ${l}`));
  }
  if (answer.ok) {
    add(answer.text);
  } else {
    lines.push(`'${answer.error}`);
    if (answer.trace.trim() !== "") {
      add(answer.trace.replace(/\n+$/, "").split("\n"));
    }
  }
  return lines;
}
