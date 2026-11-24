// The formats a result can be exported in beyond CSV (#921): Excel,
// Parquet, JSON, a Markdown table and a q expression. Each writes the rows
// shown, in the order shown, as CSV does.
//
// Markdown is for reading, so it shows the cells as the grid does, floats to
// `q-lint.query.gridDecimals`. The others are for reading back, so they
// write what the process sent (`grid.ts`'s payload): a float's every digit,
// a long past 2^53 exactly, a null as a null. JSON writes a number as a
// number, a boolean as a boolean, a null as null and everything else - a
// temporal, a symbol, an infinity, which JSON has no number for - as q's
// text; a string in a general list is its characters. Excel and Parquet are `xlsx.ts`'s and `parquet.ts`'s.
//
// HTML is for reading too: a page of one table, the cells as the grid shows
// them, coloured by the result's conditional formatting rules (#1013) as
// the grid colours them - by `media/gridlook.js`, which the page runs too.
import { charText, realValue, textBuffer, toGrid, type Grid, type GridPayload } from "./grid";
import type { FormatRule } from "./resultlook";
import { distinctNames, itemValue, rawColumn, tableParts, textNull } from "./qliteral";
import { toParquet } from "./parquet";
import { toXlsx } from "./xlsx";

export const EXPORT_FORMATS = ["xlsx", "parquet", "json", "markdown", "q", "html"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/// What a format is called, its file extension and whether it can go on
/// the clipboard as text.
export const FORMAT_INFO: Record<ExportFormat, { label: string; extension: string; text: boolean; detail: string }> = {
  xlsx: { label: "Excel", extension: "xlsx", text: false, detail: "A workbook of one sheet; numbers, booleans and temporals as Excel's own" },
  parquet: { label: "Parquet", extension: "parquet", text: false, detail: "Typed columns: integers, floats, dates and timestamps as Parquet's own" },
  json: { label: "JSON", extension: "json", text: true, detail: "An array of row objects; numbers as numbers, the rest as q writes it" },
  markdown: { label: "Markdown", extension: "md", text: true, detail: "A table, the cells as the grid shows them" },
  q: { label: "q", extension: "q", text: true, detail: "An expression that rebuilds the table on a process" },
  html: { label: "HTML", extension: "html", text: true, detail: "A page of one table, the cells as the grid shows them, with its conditional formatting" },
};

/// `media/gridlook.js`'s rule evaluation, which the result page runs.
interface GridLook {
  ruleStyles(grid: Grid, rules: FormatRule[], shown?: (column: number, row: number) => string): (Map<number, { background?: string; color?: string; bold?: boolean }> | null)[];
  columnFormats(grid: Grid): ({ kind: string } | null)[];
  formatNumber(format: { kind: string }, value: number | null, text: string): string;
}
const LOOK = require("../media/gridlook.js") as GridLook;

/// `grid` with each numeric column a name's format dresses (#1012) as the
/// grid shows its cells - 1.23% for a ret_PCT of 0.0123 - for the formats
/// that write the cells as the grid shows them (#1639).
export function shownGrid(grid: Grid): Grid {
  const formats = LOOK.columnFormats(grid);
  const cells = grid.cells.map((column, i) => {
    const f = formats[i];
    const values = grid.values[i];
    return f && grid.columns[i].numeric && values ? column.map((text, r) => LOOK.formatNumber(f, values[r], text)) : column;
  });
  return { ...grid, cells };
}

/// Text as HTML.
function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/// The rows as an HTML page of one table, the cells as the grid shows them
/// with floats to `decimals`, numeric and temporal columns aligned right,
/// each cell a rule matches styled as the grid styles it; `formats`: the
/// cells as a name's format shows them.
export function toHtml(payload: GridPayload, decimals: number, rows?: number[], rules: FormatRule[] = [], formats = false): string {
  return htmlParts(payload, decimals, rows, rules, formats).join("");
}

/// `toHtml`'s text in parts, for `textBuffer` (#1855).
function htmlParts(payload: GridPayload, decimals: number, rows?: number[], rules: FormatRule[] = [], formats = false): string[] {
  const values = toGrid(payload, decimals);
  const order = rowOrder(payload, rows);
  const grid = formats ? shownGrid(values) : values;
  const styles = LOOK.ruleStyles(values, rules, formats ? (c, r) => grid.cells[c][r] : undefined);
  const right = grid.columns.map((c) => c.numeric || c.temporal);
  const head = grid.columns.map((c, i) => `<th${right[i] ? ' class="n"' : ""}>${html(c.name)}</th>`).join("");
  const body = order.map((r) => {
    const cells = grid.cells.map((col, i) => {
      const s = styles[i]?.get(r);
      const css = s === undefined ? [] : [s.background !== undefined ? `background:${s.background}` : "", s.color !== undefined ? `color:${s.color}` : "", s.bold ? "font-weight:bold" : ""].filter((x) => x !== "");
      return `<td${right[i] ? ' class="n"' : ""}${css.length > 0 ? ` style="${css.join(";")}"` : ""}>${html(col[r] ?? "")}</td>`;
    });
    return `<tr>${cells.join("")}</tr>\n`;
  });
  return [
    "<!DOCTYPE html>\n",
    '<html><head><meta charset="utf-8"><title>q-lint: result</title>\n',
    "<style>table{border-collapse:collapse;font-family:monospace}th,td{border:1px solid #ccc;padding:2px 6px;white-space:nowrap}th{background:#f3f3f3}.n{text-align:right}</style>\n",
    "</head><body><table>\n",
    `<thead><tr>${head}</tr></thead>\n`,
    "<tbody>\n",
    ...(body.length === 0 ? ["\n"] : body),
    "</tbody>\n",
    "</table></body></html>\n",
  ];
}

/// A cell of a numeric column as JSON: a number, exactly as sent, or the
/// text q writes for an infinity.
function jsonNumber(type: number, text: string, raw: unknown): string {
  if (raw === null) {
    return "null";
  }
  if (raw === Infinity || raw === -Infinity) {
    const floating = type === 8 || type === 9;
    return JSON.stringify(`${raw < 0 ? "-" : ""}0${floating ? "w" : "W"}`);
  }
  if (raw === undefined) {
    return /^-?\d+$/.test(text) ? text : JSON.stringify(text);
  }
  // A Long writes its every digit.
  return String(raw);
}

/// The rows to write: `rows` when given, and otherwise all of them.
export function rowOrder(payload: GridPayload, rows?: number[]): number[] {
  return rows ?? [...Array(payload.cells[0]?.length ?? 0).keys()];
}

/// The rows as a JSON array of objects, one key per column.
export function toJson(payload: GridPayload, rows?: number[]): string {
  return jsonParts(payload, rows).join("");
}

/// `toJson`'s text in parts, for `textBuffer` (#1855).
function jsonParts(payload: GridPayload, rows?: number[]): string[] {
  const names = distinctNames(payload.names).map((n) => JSON.stringify(n));
  const columns = payload.names.map((_, i) => {
    const type = payload.types[i];
    const cells = payload.cells[i];
    const raw = rawColumn(payload, i);
    return (r: number): string => {
      const text = cells[r] ?? "";
      const value = raw === undefined ? undefined : raw[r];
      if (type === 1) {
        return text === "1" ? "true" : "false";
      }
      if (type === 4) {
        return String(parseInt(text, 16));
      }
      if (type >= 5 && type <= 9) {
        return jsonNumber(type, text, value);
      }
      if (value === null || textNull(type, text)) {
        return "null";
      }
      if (type === 0) {
        // A number as a number, every digit of a float (#1485); a boolean,
        // a null, a string as JSON's own (#2086).
        const item = itemValue(text, value);
        return "number" in item ? item.number : "boolean" in item ? String(item.boolean) : "null" in item ? "null" : JSON.stringify(item.text);
      }
      return JSON.stringify(type === 10 ? charText(text, value) : text);
    };
  });
  const order = rowOrder(payload, rows);
  if (order.length === 0) {
    return ["[]\n"];
  }
  const parts = order.map((r, k) => `${k === 0 ? "[\n" : ",\n"}  {${columns.map((cell, i) => `${names[i]}: ${cell(r)}`).join(", ")}}`);
  parts.push("\n]\n");
  return parts;
}

/// A cell as Markdown table text, shown as written: what Markdown reads
/// inline - code, emphasis, links, HTML, entities, strikethrough, math -
/// the pipe escaped (#1263), and braces, so no `{{q: }}` live value runs
/// (#1543); its line breaks spaces.
export function markdownCell(text: string): string {
  return text.replace(/[\\`*_[\]<>~|&${}]/g, "\\$&").replace(/\r?\n|\r/g, " ");
}

/// The rows as a Markdown table, the cells as the grid shows them with
/// floats to `decimals`, numeric and temporal columns aligned right;
/// `formats`: the cells as a name's format shows them.
export function toMarkdown(payload: GridPayload, decimals: number, rows?: number[], formats = false): string {
  return markdownParts(payload, decimals, rows, formats).join("");
}

/// `toMarkdown`'s lines, each with its `\n`, for `textBuffer` (#1855).
function markdownParts(payload: GridPayload, decimals: number, rows?: number[], formats = false): string[] {
  const values = toGrid(payload, decimals);
  const grid = formats ? shownGrid(values) : values;
  const order = rowOrder(payload, rows);
  const header = `| ${grid.columns.map((c) => markdownCell(c.name) || " ").join(" | ")} |`;
  const rule = `| ${grid.columns.map((c) => (c.numeric || c.temporal ? "---:" : "---")).join(" | ")} |`;
  const lines = [`${header}\n`, `${rule}\n`];
  for (const r of order) {
    lines.push(`| ${grid.cells.map((col) => markdownCell(col[r] ?? "")).join(" | ")} |\n`);
  }
  return lines;
}

export interface Exported {
  data: Buffer;
  /// Rows written.
  rows: number;
  /// What the user should know of what was written: rows a format could
  /// not hold, cells cut at 200 characters.
  notes: string[];
}

/// The rows of `payload` in `format`. `rules`: the result's conditional
/// formatting, which the Excel and HTML files keep. `formats`: Markdown
/// and HTML write the cells as the columns' formats show them. Text is
/// written in parts to a `Buffer`, never one string: a big result's is past
/// the longest string V8 makes (#1855).
export function exportResult(format: ExportFormat, payload: GridPayload, decimals: number, rows?: number[], rules: FormatRule[] = [], formats = false): Exported {
  const order = rowOrder(payload, rows);
  const notes: string[] = [];
  if (payload.count > (payload.cells[0]?.length ?? 0)) {
    notes.push(`the grid held ${(payload.cells[0]?.length ?? 0).toLocaleString("en-US")} of the result's ${payload.count.toLocaleString("en-US")} rows`);
  }
  switch (format) {
    case "json":
      return { data: textBuffer(jsonParts(payload, order)), rows: order.length, notes };
    case "markdown":
      return { data: textBuffer(markdownParts(payload, decimals, order, formats)), rows: order.length, notes };
    case "q": {
      const table = tableParts(payload, order);
      if (table.cut > 0) {
        notes.push(`${table.cut} cell(s) were cut at 200 characters or at the process's \\c width and are not their whole value`);
      }
      return { data: textBuffer([...table.parts, "\n"]), rows: order.length, notes };
    }
    case "xlsx": {
      const book = toXlsx(payload, order, rules);
      notes.push(...book.notes);
      return { data: book.data, rows: book.rows, notes };
    }
    case "html":
      return { data: textBuffer(htmlParts(payload, decimals, order, rules, formats)), rows: order.length, notes };
    case "parquet": {
      const file = toParquet(payload, order);
      notes.push(...file.notes);
      return { data: file.data, rows: order.length, notes };
    }
  }
}
