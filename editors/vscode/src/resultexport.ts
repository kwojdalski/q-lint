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
import { toGrid, type GridPayload } from "./grid";
import { distinctNames, plainItem, rawColumn, tableLiteral, textNull } from "./qliteral";
import { toParquet } from "./parquet";
import { toXlsx } from "./xlsx";

export const EXPORT_FORMATS = ["xlsx", "parquet", "json", "markdown", "q"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/// What a format is called, its file extension and whether it can go on
/// the clipboard as text.
export const FORMAT_INFO: Record<ExportFormat, { label: string; extension: string; text: boolean; detail: string }> = {
  xlsx: { label: "Excel", extension: "xlsx", text: false, detail: "A workbook of one sheet; numbers, booleans and temporals as Excel's own" },
  parquet: { label: "Parquet", extension: "parquet", text: false, detail: "Typed columns: integers, floats, dates and timestamps as Parquet's own" },
  json: { label: "JSON", extension: "json", text: true, detail: "An array of row objects; numbers as numbers, the rest as q writes it" },
  markdown: { label: "Markdown", extension: "md", text: true, detail: "A table, the cells as the grid shows them" },
  q: { label: "q", extension: "q", text: true, detail: "An expression that rebuilds the table on a process" },
};

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
      return JSON.stringify(type === 0 ? plainItem(text) : text);
    };
  });
  const lines = rowOrder(payload, rows).map((r) => `  {${columns.map((cell, i) => `${names[i]}: ${cell(r)}`).join(", ")}}`);
  return lines.length === 0 ? "[]\n" : `[\n${lines.join(",\n")}\n]\n`;
}

/// A cell as Markdown table text: its pipes and backslashes escaped, its
/// line breaks spaces.
export function markdownCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n|\r/g, " ");
}

/// The rows as a Markdown table, the cells as the grid shows them with
/// floats to `decimals`, numeric and temporal columns aligned right.
export function toMarkdown(payload: GridPayload, decimals: number, rows?: number[]): string {
  const grid = toGrid(payload, decimals);
  const order = rowOrder(payload, rows);
  const header = `| ${grid.columns.map((c) => markdownCell(c.name) || " ").join(" | ")} |`;
  const rule = `| ${grid.columns.map((c) => (c.numeric || c.temporal ? "---:" : "---")).join(" | ")} |`;
  const body = order.map((r) => `| ${grid.cells.map((col) => markdownCell(col[r] ?? "")).join(" | ")} |`);
  return [header, rule, ...body].join("\n") + "\n";
}

export interface Exported {
  data: Buffer;
  /// Rows written.
  rows: number;
  /// What the user should know of what was written: rows a format could
  /// not hold, cells cut at 200 characters.
  notes: string[];
}

/// The rows of `payload` in `format`.
export function exportResult(format: ExportFormat, payload: GridPayload, decimals: number, rows?: number[]): Exported {
  const order = rowOrder(payload, rows);
  const notes: string[] = [];
  if (payload.count > (payload.cells[0]?.length ?? 0)) {
    notes.push(`the grid held ${(payload.cells[0]?.length ?? 0).toLocaleString("en-US")} of the result's ${payload.count.toLocaleString("en-US")} rows`);
  }
  switch (format) {
    case "json":
      return { data: Buffer.from(toJson(payload, order), "utf8"), rows: order.length, notes };
    case "markdown":
      return { data: Buffer.from(toMarkdown(payload, decimals, order), "utf8"), rows: order.length, notes };
    case "q": {
      const table = tableLiteral(payload, order);
      if (table.cut > 0) {
        notes.push(`${table.cut} cell(s) were cut at 200 characters and are not their whole value`);
      }
      return { data: Buffer.from(`${table.code}\n`, "utf8"), rows: order.length, notes };
    }
    case "xlsx": {
      const book = toXlsx(payload, order);
      notes.push(...book.notes);
      return { data: book.data, rows: book.rows, notes };
    }
    case "parquet": {
      const file = toParquet(payload, order);
      notes.push(...file.notes);
      return { data: file.data, rows: order.length, notes };
    }
  }
}
