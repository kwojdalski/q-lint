// `.qlint.view` and `.qlint.plot` (#960), R's View() for q: called in code
// run from the editor, `.qlint.view t` opens t in the result grid and
// `.qlint.plot t` as a chart, and each gives back t, so it can sit inside
// an expression. Nothing of q-lint's lives on a process unasked, so the
// definition below is sent only by Define .qlint.view and .qlint.plot on
// Process, or on connect while q-lint.view.defineOnConnect is on.
//
// How a call reaches the editor: the function shapes the value with the
// result grid's own lambda (`grid.ts`), as a grid query would, and sends it
// back on the handle of the client that called it as an async message,
// `neg[.z.w] (`qlint; `view|`plot; answer)`. It arrives before the
// answer to the query that made the call, on the same connection, and the
// connection's async listener (`Live.onAsyncMessage`) shows it. Called with
// no client - from the process's own console or a timer, where `.z.w` is 0
// - it only gives the value back. The value is held in `.qlint.shown` only
// while it is shaped. Where q refuses that hold - in a read-only query
// under `reval`, in a secondary thread of `peach` - nothing is shown and
// it only gives the value back too, rather than failing the user's query
// (#2540), as a logpoint does (#1894).
import { deserialize } from "node-q/lib/c.js";
import { checkedBody } from "./qdecode";
import { gridLambda, readGridAnswer, type GridAnswer } from "./grid";

export const VIEW_KINDS = ["view", "plot"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/// The q that defines `.qlint.view` and `.qlint.plot`, shaping a value to
/// `size` (console lines and columns, for one that is not tabular) and
/// sending at most `limit` rows. One statement per definition, each its
/// continuation lines indented, as `statements` cuts them.
export function viewDefinition(size: [number, number], limit: number): string {
  const n = (x: number): string => (Number.isFinite(x) ? `${Math.trunc(x)}` : "0W");
  return [
    `.qlint.grid:${gridLambda(false)}`,
    ".qlint.show:{[how;x]",
    " if[not 0<.z.w;:x];",
    " if[not @[{.qlint.shown:x;1b};x;0b];:x];",
    ` a:.qlint.grid[enlist".qlint.shown";${n(size[0])} ${n(size[1])}f;${n(limit)}f];`,
    " .qlint.shown:();",
    " neg[.z.w](`qlint;how;a);",
    " x}",
    ".qlint.view:.qlint.show`view",
    ".qlint.plot:.qlint.show`plot",
  ].join("\n");
}

/// What a `.qlint.view` or `.qlint.plot` call sent, read from the whole
/// async message; undefined for any other message, which is not ours.
export function readViewMessage(message: Buffer): { kind: ViewKind; answer: GridAnswer } | undefined {
  let value: unknown;
  try {
    value = deserialize(checkedBody(message), false, true, false, false);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== "qlint") {
    return undefined;
  }
  const kind = VIEW_KINDS.find((k) => k === value[1]);
  if (kind === undefined) {
    return undefined;
  }
  try {
    return { kind, answer: readGridAnswer(value[2]) };
  } catch {
    return undefined;
  }
}
