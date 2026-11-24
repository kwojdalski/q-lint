// What a notebook cell asks the process for in `@grid` mode, and the outputs
// a cell shows.
//
// A `@chart` cell asks for what query Chart mode does - `grid.ts`'s `GRID` -
// so its chart has the same values, columns and axes as the result panel's,
// drawn by the notebook renderer `media/chartrenderer.js` from the output
// item `chartOutputs` writes.
//
// `DATA` runs the statements as `query.ts`'s `RUN` does - one lambda sent
// with the cell, nothing defined on the process, the same trace - and when
// the value is a table, answers with the table itself rather than its
// console text: each column as a list of strings, as `string` writes them
// (so a timestamp keeps its nanoseconds), a nested column's items with
// `-3!`. The columns are read by name, as `value flip` does not read them
// of a table mapped from disk - unless two share a name, which a name would
// read twice, as `grid.ts`'s `GRID` reads them - and a mapped nested column
// (77h and up) is nested too. A keyed table is unkeyed and says how many key columns it had; a
// dictionary keyed by a table whose value is not one is not a keyed table.
// At most `rows` rows are sent, with the table's count, so a large table is
// cut by the process: the first `rows`, or the last when `rows` is negative,
// and every row when it is infinite (`sublist` with `0W`). A partitioned
// table, which `sublist` refuses, is read by row index with `.Q.ind`, as
// `GRID` reads it (#1368). The row limit and
// where it counts from are `q-lint.notebook.rowLimit` and `rowLimitFrom`,
// made one signed count by `liveconfig.ts`'s `rowsArgument`. A value that is not a table answers as `RUN` would.
// `rows` and `size` arrive as floats, and are made long there.
//
//   table     `ok`table`columns`types`keys`data`total!(1b;1b;...)
//   other     `ok`table`type`text!(1b;0b;type;.Q.S lines)
//   failure   `ok`error`trace!(0b;q's error;its backtrace, or "")
//
// It works on kdb+/KDB-X and on PeachQ.
import type { Answer } from "./query";
import { NULL_TYPE } from "./query";
import type { CellMode, ChartMode } from "./celldirectives";
import type { RowLimitFrom } from "./liveconfig";
import { toGrid, type Grid, type GridAnswer } from "./grid";

export const DATA = [
  "{[s;rows;size]",
  " r:$[`trp in key `.Q;",
  "   .Q.trp[{(1b;last value each x)};s;{(0b;x;.Q.sbt -4_y)}];",
  "   @[{(1b;last value each x)};s;{(0b;x;\"\")}]];",
  " if[not r 0;:`ok`error`trace!(0b;r 1;r 2)];",
  " v:r 1;",
  " k:$[99h=type v;$[(98h=type key v)&98h=type value v;count cols key v;0];0];",
  " t:$[k>0;0!v;v];",
  " if[not 98h=type t;:`ok`table`type`text!(1b;0b;type v;.Q.S[\"j\"$size;0j] v)];",
  " n:\"j\"$rows;m:count t;",
  " u:$[1b~.Q.qp t;[j:$[n<0;(m+n)|0;0]+til m&abs n;$[count j;.Q.ind[t;j];select from t where i<0]];n sublist t];",
  " c:{$[count[cols x]=count distinct cols x;x cols x;value flip x]} u;",
  " str:{$[(0h=type x)|76h<type x;{$[10h=type x;x;-3!x]} each x;string x]};",
  " `ok`table`columns`types`keys`data`total!(1b;1b;cols t;type each c;k;str each c;count t)}",
].join("\n");

/// How many rows `@grid` and `@chart` ask for by default:
/// `q-lint.notebook.rowLimit`'s default.
export const GRID_ROWS = 1000;
/// How much of one value the grid shows.
const VALUE_LIMIT = 500;

export interface Table {
  columns: string[];
  /// Each column's q type.
  types: number[];
  /// How many of the first columns were the key of a keyed table.
  keys: number;
  /// Column by column, each value as q writes it.
  data: string[][];
  /// The table's count: more than the rows in `data` when it was cut.
  total: number;
  /// Whether a cut table holds its first rows or its last: first when unset.
  from?: RowLimitFrom;
}

export type CellData = Answer | { ok: true; table: Table };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : typeof v === "string" ? [v] : [];

/// A q long as a number: the IPC client decodes one as a `Long`.
const long = (v: unknown): number | undefined =>
  typeof v === "number"
    ? v
    : typeof (v as { toNumber?: unknown } | null)?.toNumber === "function"
      ? (v as { toNumber: () => number }).toNumber()
      : undefined;

/// The answer `DATA` gave. Throws when it is not one, as `readAnswer` does.
export function readCellData(raw: unknown): CellData {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.ok !== "boolean") {
    throw new Error(`the process answered something other than a cell result: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  if (!r.ok) {
    return {
      ok: false,
      error: typeof r.error === "string" ? r.error : String(r.error),
      trace: typeof r.trace === "string" ? r.trace : "",
    };
  }
  if (r.table !== true) {
    return { ok: true, type: typeof r.type === "number" ? r.type : 0, text: strings(r.text) };
  }
  const columns = strings(r.columns);
  const data = Array.isArray(r.data) ? r.data.map(strings) : [];
  const types = Array.isArray(r.types) ? r.types.map(Number) : [];
  if (data.length !== columns.length) {
    throw new Error(`the process answered ${data.length} columns of data for ${columns.length} column names`);
  }
  return {
    ok: true,
    table: {
      columns,
      types,
      keys: long(r.keys) ?? 0,
      data,
      total: long(r.total) ?? data[0]?.length ?? 0,
    },
  };
}

const rowCount = (table: Table): number => table.data[0]?.length ?? 0;

/// What says a table was cut, or nothing when it was not.
export function cutNote(table: Table): string | undefined {
  const shown = rowCount(table);
  return table.total > shown ? `Showing the ${table.from ?? "first"} ${shown.toLocaleString("en")} of ${table.total.toLocaleString("en")} rows.` : undefined;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/// `text` safe anywhere in HTML: as an element's text or an attribute's value.
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/// `value` cut to `VALUE_LIMIT`, never between the two halves of a character
/// outside the BMP, which would show as a replacement character.
const clip = (value: string): string => {
  if (value.length <= VALUE_LIMIT) {
    return value;
  }
  const end = /[\uD800-\uDBFF]/.test(value[VALUE_LIMIT - 2]) ? VALUE_LIMIT - 2 : VALUE_LIMIT - 1;
  return `${value.slice(0, end)}…`;
};

/// A number, right-aligned: q's byte to float (4 to 9).
const numeric = (type: number): boolean => type >= 4 && type <= 9;

const STYLE = [
  ".qnb-grid{border-collapse:collapse;font-family:var(--vscode-editor-font-family,monospace);",
  "font-size:var(--vscode-editor-font-size,13px);color:var(--vscode-editor-foreground,inherit)}",
  ".qnb-grid th,.qnb-grid td{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));",
  "padding:1px 8px;white-space:pre;text-align:left;vertical-align:top}",
  ".qnb-grid th{background:var(--vscode-editorWidget-background,rgba(128,128,128,.12));font-weight:600}",
  ".qnb-grid td.n{text-align:right}",
  ".qnb-grid th.k{border-bottom-width:2px}",
  ".qnb-grid td.k{background:var(--vscode-editorWidget-background,rgba(128,128,128,.08))}",
  ".qnb-note{opacity:.75;margin-top:4px;font-family:var(--vscode-font-family,sans-serif)}",
].join("");

/// A table as HTML: a `<style>` scoped to its own classes, coloured from the
/// editor's theme, and a `<table>`. Every name and value is escaped, and
/// there is no script.
export function tableHtml(table: Table): string {
  const rows = rowCount(table);
  const cls = (i: number): string => [i < table.keys ? "k" : "", numeric(table.types[i]) ? "n" : ""].filter(Boolean).join(" ");
  const attr = (i: number): string => (cls(i) === "" ? "" : ` class="${cls(i)}"`);
  const head = table.columns.map((c, i) => `<th${attr(i)}>${escapeHtml(c)}</th>`).join("");
  const body: string[] = [];
  for (let r = 0; r < rows; r++) {
    body.push(`<tr>${table.data.map((column, i) => `<td${attr(i)}>${escapeHtml(clip(column[r] ?? ""))}</td>`).join("")}</tr>`);
  }
  const note = cutNote(table);
  return [
    `<style>${STYLE}</style>`,
    `<table class="qnb-grid"><thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table>`,
    note === undefined ? "" : `<div class="qnb-note">${escapeHtml(note)}</div>`,
  ].join("");
}

/// A cell on one line: a newline, return or tab escaped as q writes it in a
/// string, `"a\nb"`, so a value does not break its row (#1496).
const oneLine = (value: string): string => clip(value).replace(/[\n\r\t]/g, (c) => (c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t"));

/// A table as text laid out as q's console lays it out: the names, a rule,
/// the rows, a `|` after a keyed table's key columns.
export function tableText(table: Table): string[] {
  const rows = rowCount(table);
  // A loop, not `Math.max(...)`: every row is more than a call takes arguments.
  const widths = table.columns.map((c, i) => table.data[i].reduce((w, v) => Math.max(w, oneLine(v).length), c.length));
  const line = (cell: (i: number) => string): string =>
    table.columns
      .map((_, i) => cell(i).padEnd(widths[i]) + (i === table.keys - 1 && i < table.columns.length - 1 ? "|" : ""))
      .join(" ");
  const header = line((i) => table.columns[i]);
  // A keyed table's rule breaks at its `|`, as the console's does: `-| -`.
  const keyed = table.keys > 0 && table.keys < table.columns.length;
  const keyWidth = widths.slice(0, table.keys).reduce((sum, w) => sum + w, 0) + table.keys - 1;
  const rule = keyed ? `${"-".repeat(keyWidth)}| ${"-".repeat(header.length - keyWidth - 2)}` : "-".repeat(header.length);
  const lines = [header.trimEnd(), rule];
  for (let r = 0; r < rows; r++) {
    lines.push(line((i) => oneLine(table.data[i][r] ?? "")).trimEnd());
  }
  const note = cutNote(table);
  return note === undefined ? lines : [...lines, note];
}

export interface OutputItem {
  mime: string;
  text: string;
}

/// One output of a cell: items that are views of the same thing, the editor
/// showing the richest it can, or an error.
export type OutputPart =
  | { kind: "items"; items: OutputItem[] }
  | { kind: "error"; name: string; message: string; stack: string };

const plain = (lines: string[]): OutputPart => ({ kind: "items", items: [{ mime: "text/plain", text: lines.join("\n") }] });

/// q's error as a cell's error output: its message, and its trace as the
/// stack.
export function errorPart(error: string, trace: string): OutputPart {
  const stack = trace.trim() === "" ? "" : `'${error}\n${trace.replace(/\n+$/, "")}`;
  return { kind: "error", name: "q error", message: `'${error}`, stack };
}

/// The output item the notebook chart renderer draws.
export const CHART_MIME = "application/vnd.q-lint.chart+json";

/// What a `CHART_MIME` item holds: the chart asked for and the grid it is
/// drawn from, as the result panel gets it less the sort ranks.
export interface ChartSpec {
  kind: ChartMode["chart"];
  title?: string;
  height?: number;
  /// Says the table was cut, as `cutNote` does.
  note?: string;
  grid: Omit<Grid, "rank">;
}

/// A grid as a `Table`, for its text.
const gridTable = (grid: Grid, from: RowLimitFrom): Table => ({
  columns: grid.columns.map((c) => c.name),
  types: grid.columns.map((c) => c.type),
  keys: grid.columns.filter((c) => c.key).length,
  data: grid.cells,
  total: grid.total,
  from,
});

/// The output of a `/ @chart` cell whose value was `grid`: the chart, and
/// the table as text beside it, which an editor without the renderer - or
/// another tool reading the saved notebook - shows instead. `from` says
/// which rows a cut grid holds.
export function chartOutputs(mode: ChartMode, grid: Grid, from: RowLimitFrom = "first"): OutputPart[] {
  const table = gridTable(grid, from);
  const { rank: _rank, ...shown } = grid;
  const note = cutNote(table);
  const spec: ChartSpec = {
    kind: mode.chart,
    ...(mode.title !== undefined ? { title: mode.title } : {}),
    ...(mode.height !== undefined ? { height: mode.height } : {}),
    ...(note !== undefined ? { note } : {}),
    grid: shown,
  };
  return [
    {
      kind: "items",
      items: [
        { mime: CHART_MIME, text: JSON.stringify(spec) },
        { mime: "text/plain", text: tableText(table).join("\n") },
      ],
    },
  ];
}

/// The outputs of a `/ @chart` cell that answered `answer`, `GRID`'s answer:
/// a chart when the value was a table, a dictionary or a list, and otherwise
/// what `cellOutputs` shows.
export function chartCellOutputs(mode: ChartMode, answer: GridAnswer, from: RowLimitFrom = "first"): OutputPart[] {
  if (answer.ok && answer.grid !== undefined) {
    return chartOutputs(mode, toGrid(answer.grid, -1), from);
  }
  if (answer.ok && answer.gridError !== undefined) {
    return [plain([...answer.text, `(@chart could not shape this as a table: '${answer.gridError}. It is shown as text.)`])];
  }
  return cellOutputs(mode, answer);
}

/// The outputs of a cell run in `mode` that answered `data`. A console run
/// that gave q's generic null, such as an assignment ending in `;`, shows
/// nothing, as q's console does. `from` says which rows a cut table holds.
export function cellOutputs(mode: CellMode, data: CellData, from: RowLimitFrom = "first"): OutputPart[] {
  if (!data.ok) {
    return [errorPart(data.error, data.trace)];
  }
  if ("table" in data) {
    const table: Table = { ...data.table, from };
    return [
      {
        kind: "items",
        items: [
          { mime: "text/html", text: tableHtml(table) },
          { mime: "text/plain", text: tableText(table).join("\n") },
        ],
      },
    ];
  }
  if (data.type === NULL_TYPE) {
    return [];
  }
  if (mode.mode === "console") {
    return [plain(data.text)];
  }
  return [plain([...data.text, `(@${mode.mode} shows a table; this is not one, so it is shown as text.)`])];
}
