// Charts from a file or a query (#1031), without a window: a CSV or JSON
// table, or a q query's answer, drawn as an SVG chart by the very code the
// result panel saves its charts with (`media/chartspec.js`'s `chartSvg`).
// Free of any `vscode` import, so node tests it and `chartcli.ts` runs it
// from a shell; `dbtoolsview.ts` offers it as a command.
//
// A CSV's first row names the columns; a column is numeric when every cell
// it has parses as a number, and is otherwise text, which a chart takes as
// its x axis' labels. JSON is an array of objects (rows) or an object of
// arrays (columns), as `.j.j` writes a table. A chart is SVG only: a PNG
// would need a rasterizer, and so a dependency.
import type { Column, Grid, GridPayload } from "./grid";
import { toGrid } from "./grid";
import { keysOf, parseOrdered } from "./jsonq";
import { readDelimited } from "./pastetable";

// The chart code is the webviews' own, plain script; it exports itself to
// node when `module` is there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const charts = require("../media/chartspec.js") as {
  chartable: (grid: Grid, kind: string) => number[];
  chartData: (grid: Grid, rows: number[], kind: string, columns: number[], bins: number, ohlc?: number[]) => { datasets: { column: number }[]; note?: string };
  chartSvg: (grid: Grid, rows: number[], kind: string, data: unknown, look: unknown, opts: unknown) => string;
  BINS: number;
};

export const CHART_KINDS = ["line", "area", "step", "bar", "scatter", "histogram", "candlestick"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/// A decimal number as a file writes one. `Number` alone also reads 0x1F,
/// 0b11 and 0o17, which in a table are ids, not quantities (#1954).
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const isNumber = (s: string) => DECIMAL.test(s.trim()) && Number.isFinite(Number(s));

/// A grid of named columns of text cells: numeric where every non-empty
/// cell is a number, and `numbers` (by column) does not say it holds none.
export function gridOf(names: string[], cells: string[][], numbers?: boolean[]): Grid {
  const columns: Column[] = names.map((name, i) => {
    const numeric = (numbers?.[i] ?? true) && cells[i].some((c) => c.trim() !== "") && cells[i].every((c) => c.trim() === "" || isNumber(c));
    return { name, type: numeric ? 9 : 11, typeName: numeric ? "float" : "symbol", key: false, numeric, temporal: false };
  });
  return {
    columns,
    cells,
    rank: names.map(() => null),
    values: columns.map((c, i) => (c.numeric ? cells[i].map((s) => (isNumber(s) ? Number(s) : null)) : null)),
    total: cells[0]?.length ?? 0,
  };
}

/// A CSV (or, by its first line, a tab-separated) table as a grid, read in
/// whole records: a quoted field may hold the separator, a newline (#1115)
/// and `""` for a quote.
export function gridFromCsv(text: string, tabs = false): Grid {
  const first = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "");
  if (first === undefined) {
    throw new Error("the file has no header row");
  }
  // The separator the header has more of, outside quotes: a tab-separated
  // header may hold a comma (#2457). Tabs for a `.tsv` or `.tab` file.
  const fields = (sep: string) => readDelimited(first, sep).rows[0]?.length ?? 0;
  const sep = tabs || fields("\t") > fields(",") ? "\t" : ",";
  const all = readDelimited(text, sep).rows;
  const blank = (r: string[]) => r.length === 1 && r[0].trim() === "";
  // A blank line is no record, but in a file of one column it is an empty
  // cell: only those before the header are dropped there (#2458).
  const header = all.findIndex((r) => !blank(r));
  const records = header >= 0 && all[header].length === 1 ? all.slice(header) : all.filter((r) => !blank(r));
  if (records.length === 0) {
    // Lines, but no record: an empty quoted field is all there is (#1939).
    throw new Error("the file has no header row");
  }
  const names = records[0].map((n) => n.trim());
  const rows = records.slice(1);
  return gridOf(names, names.map((_, i) => rows.map((r) => r[i] ?? "")));
}

/// A JSON value a numeric column holds: a number or a null. A string of
/// digits ("02134") is text there, as JSON says (#2469).
const numberOrNull = (v: unknown) => v === null || v === undefined || typeof v === "number";

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/// A JSON table - an array of row objects, or an object of column arrays -
/// as a grid. A byte order mark before it, as some tools write a UTF-8
/// file, is not part of the JSON (#1940). Columns are in the order the text
/// names them: `Object.keys` puts integer-like names first (#2449).
export function gridFromJson(json: string): Grid {
  const source = json.replace(/^\uFEFF/, "");
  JSON.parse(source);
  const v = parseOrdered(source) as unknown;
  const keys = (o: object): string[] => [...new Set(keysOf(o as Parameters<typeof keysOf>[0]))];
  if (Array.isArray(v)) {
    const rows = v.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r));
    if (rows.length === 0) throw new Error("the JSON is not an array of objects");
    const names = [...new Set(rows.flatMap(keys))];
    // A row's own keys only: one lacking `valueOf` is an empty cell, not
    // Object.prototype's method (#1480).
    const at = (r: Record<string, unknown>, n: string) => (Object.hasOwn(r, n) ? r[n] : undefined);
    return gridOf(names, names.map((n) => rows.map((r) => text(at(r, n)))), names.map((n) => rows.every((r) => numberOrNull(at(r, n)))));
  }
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const cols = keys(o).map((n): [string, unknown] => [n, o[n]]).filter(([, c]) => Array.isArray(c)) as [string, unknown[]][];
    if (cols.length === 0) throw new Error("the JSON is not an object of column arrays");
    // As long as the longest: a shorter column ends in empty cells, so no
    // value is dropped for sitting past the first column's end (#1941).
    const rows = Math.max(...cols.map(([, c]) => c.length));
    return gridOf(cols.map(([n]) => n), cols.map(([, c]) => Array.from({ length: rows }, (_, i) => text(c[i]))), cols.map(([, c]) => c.every(numberOrNull)));
  }
  throw new Error("the JSON is not a table: an array of objects or an object of arrays");
}

/// A grid from a file's text, by its name's extension (`.json` is JSON,
/// anything else CSV).
export function gridFromFile(name: string, content: string): Grid {
  return /\.json$/i.test(name) ? gridFromJson(content) : gridFromCsv(content, /\.(tsv|tab)$/i.test(name));
}

/// A q query's grid payload as a grid.
export function gridFromPayload(payload: GridPayload): Grid {
  return toGrid(payload, -1);
}

/// Colours for a chart on a light page.
export const LIGHT = {
  colours: ["#3794ff", "#d18616", "#388a34", "#e51400", "#8a5ac0", "#b58900"],
  foreground: "#333333",
  border: "#cccccc",
  font: "sans-serif",
  up: "#388a34",
  down: "#e51400",
};

export interface ChartOptions {
  kind: ChartKind;
  /// Columns to plot, by name; all the numeric ones (not the first) when
  /// none. A candlestick's are four: its open, high, low and close, in
  /// that order (#3126).
  y?: string[];
  /// The column on the x axis, by name; the first when none.
  x?: string;
  title?: string;
  width?: number;
  height?: number;
  background?: string;
}

/// The grid with column `x` moved first, the x axis.
function withX(grid: Grid, x: string | undefined): Grid {
  if (x === undefined) return grid;
  const at = grid.columns.findIndex((c) => c.name === x);
  if (at < 0) throw new Error(`no column ${x}: the columns are ${grid.columns.map((c) => c.name).join(", ")}`);
  const order = [at, ...grid.columns.map((_, i) => i).filter((i) => i !== at)];
  return { columns: order.map((i) => grid.columns[i]), cells: order.map((i) => grid.cells[i]), rank: order.map((i) => grid.rank[i]), values: order.map((i) => grid.values[i]), total: grid.total };
}

/// The chart of `grid` as an SVG document.
export function chartFromGrid(source: Grid, options: ChartOptions): string {
  if (!CHART_KINDS.includes(options.kind)) {
    throw new Error(`a chart is one of ${CHART_KINDS.join(", ")}`);
  }
  const grid = withX(source, options.x);
  const rows = [...Array(grid.cells[0]?.length ?? 0).keys()];
  const can = charts.chartable(grid, options.kind);
  let columns = can;
  let ohlc: number[] | undefined;
  if (options.y !== undefined && options.y.length > 0) {
    columns = options.y.map((name) => {
      const at = grid.columns.findIndex((c) => c.name === name);
      if (at < 0) throw new Error(`no column ${name}: the columns are ${grid.columns.map((c) => c.name).join(", ")}`);
      if (!can.includes(at)) throw new Error(`column ${name} is not numeric, or is the x axis`);
      return at;
    });
    if (options.kind === "candlestick") {
      // The columns named are the candles, not the ones the chart would
      // find by itself (#3126).
      if (columns.length !== 4) throw new Error(`a candlestick takes four columns, its open, high, low and close in that order: ${columns.length} given`);
      ohlc = columns;
    }
  }
  const data = charts.chartData(grid, rows, options.kind, columns, charts.BINS, ohlc);
  return charts.chartSvg(grid, rows, options.kind, data, LIGHT, {
    width: options.width ?? 800,
    height: options.height ?? 450,
    background: options.background ?? "#ffffff",
    ...(options.title ? { title: options.title } : {}),
  });
}
