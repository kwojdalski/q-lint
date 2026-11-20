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
export const TRAP = [
  " r:$[`trp in key `.Q;",
  "   .Q.trp[{(1b;last value each x)};s;{(0b;x;.Q.sbt -4_y)}];",
  "   @[{(1b;last value each x)};s;{(0b;x;\"\")}]];",
];

export const RUN = [
  "{[s;size]",
  ...TRAP,
  " $[r 0;",
  "   `ok`type`text!(1b;type r 1;.Q.S[\"j\"$size;0j] r 1);",
  "   `ok`error`trace!(0b;r 1;r 2)]}",
].join("\n");

export type Answer =
  | { ok: true; type: number; text: string[] }
  | { ok: false; error: string; trace: string };

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
  if (options.includeQuery) {
    lines.push(...shown.code.split("\n").map((l) => `q) ${l}`));
  }
  if (answer.ok) {
    lines.push(...answer.text);
  } else {
    lines.push(`'${answer.error}`);
    if (answer.trace.trim() !== "") {
      lines.push(...answer.trace.replace(/\n+$/, "").split("\n"));
    }
  }
  return lines;
}
