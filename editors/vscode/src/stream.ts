// A tickerplant table streamed into a live grid (#915), as data: what is
// sent to subscribe, how an update is read, and the last rows kept. No
// `vscode` import, so node tests it; `streamview.ts` is the panel around it.
//
// The subscription is TorQ's and kdb+tick's own: `.u.sub[table;`]` on a
// connection of its own, after which the tickerplant sends each update as
// the async message `(`upd;table;data)`. The lambda that subscribes defines
// nothing on the tickerplant; it answers with the table's columns, since the
// codec gives an empty table none.
import { gridOfQ } from "./qformat";
import type { QValue } from "./qdecode";

export const STREAM_COMMANDS = {
  start: "q-lint.streamTable",
} as const;

/// The most rows `q-lint.tickerplant.stream.rows` may keep.
export const MAX_STREAM_ROWS = 10_000;

export interface StreamSettings {
  /// Off by default: a subscriber is a load on a tickerplant.
  enabled: boolean;
  /// The rows the grid keeps, the newest.
  rows: number;
}

export function readStream(get: <T>(key: string, fallback: T) => T): StreamSettings {
  const rows = get<unknown>("tickerplant.stream.rows", 1000);
  return {
    enabled: get<unknown>("tickerplant.stream.enable", false) === true,
    rows: typeof rows === "number" && Number.isInteger(rows) && rows >= 1 ? Math.min(rows, MAX_STREAM_ROWS) : 1000,
  };
}

/// What subscribes to one table: the table's name back, its columns and
/// their types.
export const SUBSCRIBE = "{r:.u.sub[x;`]; (r 0; cols r 1; exec t from meta r 1)}";

/// What lists the tables a tickerplant publishes: an expression, sent as a
/// string for the process to evaluate.
export const TABLES = "$[`t in key `.u; .u.t; tables`.]";

/// The rows an update of `table` carries, each a row of q's text of its
/// cells in `columns` order, or undefined when `q` is not an update of
/// `table`. The data is a table, a list of columns, or one row as a list of
/// atoms, each in the order `columns` names. Items all strings are one row
/// of string columns unless the columns are chars (`types`, meta's letters,
/// when the subscription said) or, untold, they are lists of one length
/// (#1582).
export function readUpdate(q: QValue, table: string, columns: string[], types?: string): string[][] | undefined {
  if (q.kind !== "list" || q.v.length !== 3) {
    return undefined;
  }
  const [fn, name, data] = q.v;
  if (fn.kind !== "atom" || fn.t !== -11 || name.kind !== "atom" || name.t !== -11 || name.v !== table) {
    return undefined;
  }
  let shaped: QValue;
  if (data.kind === "table") {
    shaped = data;
  } else if (data.kind === "list" && data.v.length === columns.length && data.v.every((c) => c.kind === "vector" || c.kind === "list" || c.kind === "chars") && asColumns(data.v, types)) {
    shaped = { kind: "table", attr: 0, cols: columns, data: data.v };
  } else if (data.kind === "list" && data.v.length === columns.length) {
    // One row: each atom made a one-item column, a char one a string of
    // its byte, as a char column arrives (#1490).
    const column = (x: QValue): QValue =>
      x.kind !== "atom"
        ? { kind: "list", attr: 0, v: [x] }
        : x.t === -10
          ? { kind: "chars", attr: 0, v: Buffer.from([Number(x.v)]) }
          : { kind: "vector", t: -x.t, attr: 0, v: [x.v] };
    shaped = { kind: "table", attr: 0, cols: columns, data: data.v.map(column) };
  } else {
    return undefined;
  }
  const grid = gridOfQ(shaped, Infinity);
  if (grid === undefined) {
    return undefined;
  }
  const at = columns.map((c) => grid.names.indexOf(c));
  return Array.from({ length: grid.count }, (_, r) => at.map((i) => (i < 0 ? "" : (grid.cells[i][r] ?? ""))));
}

/// Whether lists of a list update are its columns, not one row's cells.
function asColumns(items: QValue[], types: string | undefined): boolean {
  const length = (x: QValue): number => (x.kind === "chars" ? x.v.length : x.kind === "vector" || x.kind === "list" ? x.v.length : -1);
  if (!items.every((x) => length(x) === length(items[0]))) {
    return false;
  }
  return !items.every((x) => x.kind === "chars") || types === undefined || types.length !== items.length || [...types].every((t) => t === "c");
}

/// The last `limit` rows received, and how many came in all.
export class RowWindow {
  private kept: string[][] = [];
  total = 0;

  constructor(private readonly limit: number) {}

  push(rows: string[][]): void {
    this.total += rows.length;
    this.kept = rows.length >= this.limit ? rows.slice(-this.limit) : [...this.kept, ...rows].slice(-this.limit);
  }

  /// The rows kept, oldest first.
  rows(): string[][] {
    return this.kept;
  }
}
