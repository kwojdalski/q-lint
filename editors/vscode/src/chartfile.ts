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
import { readDelimited } from "./pastetable";

// The chart code is the webviews' own, plain script; it exports itself to
// node when `module` is there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const charts = require("../media/chartspec.js") as {
  chartable: (grid: Grid, kind: string) => number[];
  chartData: (grid: Grid, rows: number[], kind: string, columns: number[], bins: number) => { datasets: { column: number }[]; note?: string };
  chartSvg: (grid: Grid, rows: number[], kind: string, data: unknown, look: unknown, opts: unknown) => string;
  BINS: number;
};

export const CHART_KINDS = ["line", "area", "step", "bar", "scatter", "histogram", "candlestick"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

const isNumber = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));

/// A grid of named columns of text cells: numeric where every non-empty
/// cell is a number.
export function gridOf(names: string[], cells: string[][]): Grid {
  const columns: Column[] = names.map((name, i) => {
    const numeric = cells[i].some((c) => c.trim() !== "") && cells[i].every((c) => c.trim() === "" || isNumber(c));
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
export function gridFromCsv(text: string): Grid {
  const first = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "");
  if (first === undefined) {
    throw new Error("the file has no header row");
  }
  const sep = first.includes("\t") && !first.includes(",") ? "\t" : ",";
  const records = readDelimited(text, sep).rows.filter((r) => r.length > 1 || r[0].trim() !== "");
  if (records.length === 0) {
    // Lines, but no record: an empty quoted field is all there is (#1939).
    throw new Error("the file has no header row");
  }
  const names = records[0].map((n) => n.trim());
  const rows = records.slice(1);
  return gridOf(names, names.map((_, i) => rows.map((r) => r[i] ?? "")));
}

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/// A JSON table - an array of row objects, or an object of column arrays -
/// as a grid. A byte order mark before it, as some tools write a UTF-8
/// file, is not part of the JSON (#1940).
export function gridFromJson(json: string): Grid {
  const v: unknown = JSON.parse(json.replace(/^\uFEFF/, ""));
  if (Array.isArray(v)) {
    const rows = v.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r));
    if (rows.length === 0) throw new Error("the JSON is not an array of objects");
    const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    // A row's own keys only: one lacking `valueOf` is an empty cell, not
    // Object.prototype's method (#1480).
    return gridOf(names, names.map((n) => rows.map((r) => text(Object.hasOwn(r, n) ? r[n] : undefined))));
  }
  if (v !== null && typeof v === "object") {
    const cols = Object.entries(v as Record<string, unknown>).filter(([, c]) => Array.isArray(c)) as [string, unknown[]][];
    if (cols.length === 0) throw new Error("the JSON is not an object of column arrays");
    // As long as the longest: a shorter column ends in empty cells, so no
    // value is dropped for sitting past the first column's end (#1941).
    const rows = Math.max(...cols.map(([, c]) => c.length));
    return gridOf(cols.map(([n]) => n), cols.map(([, c]) => Array.from({ length: rows }, (_, i) => text(c[i]))));
  }
  throw new Error("the JSON is not a table: an array of objects or an object of arrays");
}

/// A grid from a file's text, by its name's extension (`.json` is JSON,
/// anything else CSV).
export function gridFromFile(name: string, content: string): Grid {
  return /\.json$/i.test(name) ? gridFromJson(content) : gridFromCsv(content);
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
  /// none.
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
  if (options.y !== undefined && options.y.length > 0) {
    columns = options.y.map((name) => {
      const at = grid.columns.findIndex((c) => c.name === name);
      if (at < 0) throw new Error(`no column ${name}: the columns are ${grid.columns.map((c) => c.name).join(", ")}`);
      if (!can.includes(at)) throw new Error(`column ${name} is not numeric, or is the x axis`);
      return at;
    });
  }
  const data = charts.chartData(grid, rows, options.kind, columns, charts.BINS);
  return charts.chartSvg(grid, rows, options.kind, data, LIGHT, {
    width: options.width ?? 800,
    height: options.height ?? 450,
    background: options.background ?? "#ffffff",
    ...(options.title ? { title: options.title } : {}),
  });
}
