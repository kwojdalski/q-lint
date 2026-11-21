// Spreadsheet data as a q table (#967): CSV or TSV, as a spreadsheet copies
// it, read into columns whose type each is inferred, and written as the
// `([] ...)` literal that gives that table. Free of any `vscode` import, so
// node tests it; `pastetableview.ts` reads the clipboard and inserts it.
//
// A column is booleans when every cell is true or false; else longs, floats,
// dates, timestamps or times when every filled cell reads as one, an empty
// cell being that type's null; else symbols, or strings once a cell holds a
// space or is long. Each cell is read as q's `0:` reads the same text with
// the same type letter, so the literal is the table `("JF..";",") 0:` would
// load (test/pastetable_q.test.js checks it). The literal itself is
// qliteral.ts's, which writes a grid result as q.
import { columnLiteral, numberText, plainName, stringLiteral } from "./qliteral";
import { format, parse } from "./temporal";

/// The commands of the paste and JSON features (`pasteview.ts`).
export const PASTE = {
  table: "q-lint.pasteAsTable",
  json: "q-lint.pasteJsonAsQ",
  copyJson: "q-lint.copyAsJson",
} as const;

/// What a column holds, with the letter q's `0:` reads it with.
export type ColumnKind = "boolean" | "long" | "float" | "date" | "timestamp" | "time" | "symbol" | "string";
export const LOAD_LETTER: Record<ColumnKind, string> = {
  boolean: "B", long: "J", float: "F", date: "D", timestamp: "P", time: "T", symbol: "S", string: "*",
};

/// A string becomes a symbol unless it is longer than this or holds a space.
const SYMBOL_LENGTH = 40;
/// Rows a paste may hold: a literal of more is no use in source.
export const MAX_ROWS = 10000;

/// Rows of fields, read as RFC 4180 reads CSV: a field in double quotes may
/// hold the delimiter, a newline and `""` for a quote. `delimiter` is a tab,
/// comma or semicolon, whichever the first line has most of when not given.
export function readDelimited(text: string, delimiter?: string): { delimiter: string; rows: string[][] } {
  const body = text.replace(/^﻿/, "");
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => first.split(c).length - 1;
  const d = delimiter ?? (count("\t") > 0 ? "\t" : count(";") > count(",") ? ";" : ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (c === d) {
      row.push(field);
      field = "";
      wasQuoted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      wasQuoted = false;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0 || wasQuoted) {
    row.push(field);
    rows.push(row);
  }
  // A blank line, such as the one a spreadsheet ends its copy with, is no row.
  return { delimiter: d, rows: rows.filter((r) => r.length > 1 || r[0] !== "") };
}

const LONG = /^-?\d+$/;
const FLOAT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
// One separator throughout: q's `0:` reads no 2024.01-02.
const DATE = /^(\d{4})([-.])(\d{2})\2(\d{2})$/;
const STAMP = /^(\d{4})([-.])(\d{2})\2(\d{2})[ TD](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)Z?$/;
const TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const LONG_MAX = 9223372036854775807n;

/// A cell as q's literal of `kind`, or undefined when it is not one. An
/// empty cell is the type's null.
export function cellLiteral(kind: ColumnKind, cell: string): string | undefined {
  const text = cell.trim();
  switch (kind) {
    case "boolean":
      return /^true$/i.test(text) ? "1b" : /^false$/i.test(text) ? "0b" : undefined;
    case "long": {
      if (text === "") {
        return "0N";
      }
      // q's null long is no number a spreadsheet would hold.
      return LONG.test(text) && BigInt(text) <= LONG_MAX && BigInt(text) >= -LONG_MAX ? String(BigInt(text)) : undefined;
    }
    case "float": {
      if (text === "") {
        return "0n";
      }
      if (!FLOAT.test(text)) {
        return undefined;
      }
      const x = Number(text);
      return Number.isFinite(x) ? floatText(x) : undefined;
    }
    case "date": {
      if (text === "") {
        return "0Nd";
      }
      const m = DATE.exec(text);
      const t = m === null ? undefined : parse(`${m[1]}.${m[3]}.${m[4]}`);
      return t === undefined ? undefined : format(t);
    }
    case "timestamp": {
      if (text === "") {
        return "0Np";
      }
      const m = STAMP.exec(text);
      const t = m === null ? undefined : parse(`${m[1]}.${m[3]}.${m[4]}D${m[5]}`);
      // Only where KDB-X reads a timestamp literal: 1709 to 2290.
      const year = m === null ? 0 : Number(m[1]);
      return t === undefined || year < 1709 || year > 2290 ? undefined : format(t);
    }
    case "time": {
      if (text === "") {
        return "0Nt";
      }
      const m = TIME.exec(text);
      if (m === null || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) {
        return undefined;
      }
      // Written whole: KDB-X reads 09:30 as a time, PeachQ does not.
      return `${m[1]}:${m[2]}:${m[3] ?? "00"}.${(m[4] ?? "").padEnd(3, "0")}`;
    }
    case "symbol":
      return symbolText(text);
    case "string": {
      const s = stringLiteral(cell);
      return qString(cell);
    }
  }
}

/// A symbol's literal: bare when q reads it back as written, which a name
/// starting with `_` it does not (`` `_y `` is `` ` `` and `_y`).
export function symbolText(name: string): string {
  return /^(?:[A-Za-z0-9.][A-Za-z0-9_.]*)?$/.test(name) ? `\`${name}` : `\`$${stringLiteral(name)}`;
}

/// A string's literal as a list: q holds it as UTF-8 bytes, so one byte
/// is a char to `enlist` and `"é"` is two already. Not `,"x"`: q refuses
/// that as a list item, `("ab";,"x")`.
export function qString(text: string): string {
  const s = stringLiteral(text);
  return new TextEncoder().encode(text).length === 1 ? `enlist ${s}` : s;
}

/// A float's literal that reads back as the same double, and as a float
/// however it is written: `1f`, `1.5`, `1e+300` as `1e300`. A whole number
/// of more than 15 digits is written with an exponent, which PeachQ reads
/// where it would refuse 12345678901234567000f.
export function floatText(x: number): string {
  const s = numberText(x);
  if (/^-?\d+$/.test(s)) {
    return s.replace(/^-/, "").length > 15 ? x.toExponential().replace("e+", "e") : `${s}f`;
  }
  return s;
}

/// The kind of a column of cells: the first that reads every one.
export function inferKind(cells: string[]): ColumnKind {
  const filled = cells.filter((c) => c.trim() !== "");
  if (filled.length === 0) {
    return "symbol";
  }
  if (filled.length === cells.length && cells.every((c) => cellLiteral("boolean", c) !== undefined)) {
    return "boolean";
  }
  for (const kind of ["long", "float", "date", "timestamp", "time"] as const) {
    if (filled.every((c) => cellLiteral(kind, c) !== undefined)) {
      return kind;
    }
  }
  return cells.some((c) => /\s/.test(c.trim()) || c.length > SYMBOL_LENGTH) ? "string" : "symbol";
}

/// A header cell as a q name: letters, digits and underscores, starting
/// with a letter; `c1`, `c2` ... for one with none.
export function columnName(cell: string, i: number): string {
  const name = cell.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return name === "" ? `c${i + 1}` : /^[A-Za-z]/.test(name) ? name : `c${name}`;
}

export interface PastedTable {
  /// The q expression.
  code: string;
  names: string[];
  kinds: ColumnKind[];
  /// Data rows, not counting a header.
  rows: number;
  header: boolean;
  /// Rows left out past MAX_ROWS.
  dropped: number;
}

/// Whether the first row is a header: more than one row, and none of its
/// cells empty or reading as its column's type below.
function hasHeader(rows: string[][], width: number): boolean {
  if (rows.length < 2) {
    return false;
  }
  for (let c = 0; c < width; c++) {
    const cell = rows[0][c] ?? "";
    const kind = inferKind(rows.slice(1).map((r) => r[c] ?? ""));
    if (cell.trim() === "" || (kind !== "symbol" && kind !== "string" && cellLiteral(kind, cell) !== undefined)) {
      return false;
    }
  }
  // Text over text is taken for a header too, as a spreadsheet's usually is.
  return true;
}

/// The table literal of CSV or TSV `text`, or a reason it has none.
export function pasteTable(text: string, delimiter?: string): PastedTable | { error: string } {
  const { rows: all } = readDelimited(text, delimiter);
  if (all.length === 0) {
    return { error: "the clipboard holds no rows." };
  }
  const width = Math.max(...all.map((r) => r.length));
  const header = hasHeader(all, width);
  const data = header ? all.slice(1) : all;
  const kept = data.slice(0, MAX_ROWS);
  const names: string[] = [];
  for (let c = 0; c < width; c++) {
    let name = header ? columnName(all[0][c] ?? "", c) : `c${c + 1}`;
    // `([] ...)` takes no reserved word: `count` becomes `count_`.
    if (!plainName(name)) {
      name = `${name}_`;
    }
    for (let k = 1; names.includes(name); k++) {
      name = `${header ? columnName(all[0][c] ?? "", c) : `c${c + 1}`}_${k}`;
    }
    names.push(name);
  }
  const kinds: ColumnKind[] = [];
  const columns = names.map((name, c) => {
    const cells = kept.map((r) => r[c] ?? "");
    const kind = inferKind(cells);
    kinds.push(kind);
    const items = cells.map((cell) => cellLiteral(kind, cell) as string);
    if (kind === "symbol" || kind === "string") {
      return columnLiteral(kind === "symbol" ? 11 : 0, items);
    }
    return vectorLiteral(kind, items);
  });
  const code = `([] ${names.map((n, c) => `${n}:${columns[c]}`).join("; ")})`;
  return { code, names, kinds, rows: kept.length, header, dropped: data.length - kept.length };
}

/// Atoms side by side, as q writes a vector: `1 2 3`, `1.5 0n 2f`, `101b`,
/// `2024.01.02 0Nd`; `enlist` of one, a typed empty list of none.
function vectorLiteral(kind: Exclude<ColumnKind, "symbol" | "string">, items: string[]): string {
  if (items.length === 0) {
    return `"${LOAD_LETTER[kind].toLowerCase()}"$()`;
  }
  if (items.length === 1) {
    return `enlist ${items[0]}`;
  }
  if (kind === "boolean") {
    return `${items.map((b) => b[0]).join("")}b`;
  }
  if (kind === "long") {
    return items.join(" ");
  }
  // q reads a typed null only last in a vector, `2024.01.02 0Nd`, and
  // refuses `0Nd 2024.01.02`: with one, the items go in a list, which q
  // makes a vector.
  if (kind !== "float") {
    return items.some((s) => s.startsWith("0N")) ? `(${items.join(";")})` : items.join(" ");
  }
  // Each float's own `f` dropped; one at the end when no item says float.
  const bare = items.map((s) => s.replace(/f$/, ""));
  return bare.some((s) => /[.enw]/.test(s)) ? bare.join(" ") : `${bare.join(" ")}f`;
}
