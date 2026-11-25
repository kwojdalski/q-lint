// Asynchronous queries (#1037), as data: the lambda sent as an async
// message, and the answer it sends back. No `vscode` import, so node tests
// it; `asyncqueryview.ts` sends and listens.
//
// The query goes as an async message, `(ASYNC; id; statements; size;
// limit)`, so the connection is not held waiting: other queries can be sent
// meanwhile (the process runs them after it, one message at a time). When
// it is done, the lambda shapes the value with the result grid's own lambda
// and sends it back on the caller's handle, `neg[.z.w] (`qlintAsync; id;
// answer)`, which the connection's async listener reads. Nothing is kept on
// the process.
import { deserialize } from "node-q/lib/c.js";
import { checkedBody } from "./qdecode";
import { GRID, GRID_READ_ONLY, readGridAnswer, type GridAnswer, type GridPayload } from "./grid";

export const ASYNC_TAG = "qlintAsync";

/// The lambda an async query runs: the grid lambda's answer, sent back.
export const ASYNC = `{[id;s;size;limit] neg[.z.w](\`${ASYNC_TAG};id;${GRID}[s;size;limit])}`;
/// `ASYNC` under `reval`, sent while the read-only guard's backstop is set
/// on a process that has it (`QConnection.underReval`): a write the guard
/// missed comes back as `reval`'s error, not made.
export const ASYNC_READ_ONLY = `{[id;s;size;limit] neg[.z.w](\`${ASYNC_TAG};id;${GRID_READ_ONLY}[s;size;limit])}`;

/// What an async query sent back, read from the whole async message;
/// undefined for any other message, which is not ours.
export function readAsyncMessage(message: Buffer): { id: number; answer: GridAnswer } | undefined {
  let value: unknown;
  try {
    value = deserialize(checkedBody(message), false, true, false, false);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== ASYNC_TAG || typeof value[1] !== "number") {
    return undefined;
  }
  try {
    return { id: value[1], answer: readGridAnswer(value[2]) };
  } catch {
    return undefined;
  }
}

/// A value that is not tabular, as a one-column table of its lines, so the
/// result panel shows it too.
export function textPayload(lines: string[]): GridPayload {
  return { count: lines.length, keys: 0, names: ["value"], types: [10], cells: [lines], raw: [[]], rank: [[]] };
}
