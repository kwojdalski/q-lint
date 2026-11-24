// A `.qnb` notebook as git and a reviewer want to read it: its cells only,
// as text (#998). No import but Node's own, so the compiled
// `out/qnbgit.js` runs on its own: as git's `textconv` for `*.qnb`, which
// makes `git diff` and `git log -p` show changed cells rather than JSON,
// and as the `clean` filter that strips outputs on commit (#999).
//
//   node out/qnbgit.js --text NB.qnb     the notebook's cells as text
//   node out/qnbgit.js --strip [NB.qnb]  the notebook without its outputs,
//                                        from the file or stdin, to stdout
//
// The text leaves out what changes on every run and says nothing about the
// code: outputs, run numbers and times, and metadata. Each cell is a `%%`
// line naming its kind - and its language, when it is not q - then its
// source. The header line carries no cell number, so a cell added at the
// top changes one hunk, not every header after it.
//
// Stripping takes out each cell's `outputs`, its `execution` (run number
// and times) and the live values kept in a Markdown cell's metadata, and
// keeps everything else - fields this extension does not know included -
// in the order and the layout the extension writes, so a notebook saved
// after a strip is the same file.
//
// A file that is not a notebook is given back as it is: git shows what it
// has, and commits what it has, rather than failing.
import * as fs from "node:fs";

/// The cell of a notebook these read: a `.qnb` file's, or `qnb.ts`'s.
export interface CellLike {
  kind?: unknown;
  /// A string, or a list of lines as the file keeps it.
  source?: unknown;
  language?: unknown;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/// `raw` read as a notebook's JSON, or undefined when it is not one.
export function notebookJson(raw: string): { cells: CellLike[] } & Json | undefined {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  try {
    // As `qnb.ts`'s `lossless`, which this file cannot import: an integer
    // too big for a number is written back as it was (#1562).
    const raw = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
    const json: unknown = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === "number" && !Number.isSafeInteger(value) && raw !== undefined && /^-?\d+$/.test(context?.source ?? "") ? raw(context?.source ?? "") : value,
    );
    return isObject(json) && typeof json.qnb === "number" && Array.isArray(json.cells) && json.cells.every(isObject)
      ? (json as { cells: CellLike[] } & Json)
      : undefined;
  } catch {
    return undefined;
  }
}

const sourceOf = (cell: CellLike): string =>
  typeof cell.source === "string" ? cell.source : Array.isArray(cell.source) ? cell.source.map(String).join("\n") : "";

/// What a cell's header line says: `markdown`, `code`, or `code <language>`.
function kindOf(cell: CellLike): string {
  if (cell.kind === "markdown") {
    return "markdown";
  }
  const language = typeof cell.language === "string" && cell.language !== "q" ? cell.language : undefined;
  return language === undefined ? "code" : `code ${language}`;
}

/// The cells as text: a `%%` header and the source of each, a blank line
/// between them. `name` heads it when given.
export function notebookText(cells: readonly CellLike[], name?: string): string {
  const parts: string[] = [];
  if (name !== undefined) {
    parts.push(`q notebook ${name}: cells only; outputs, run numbers and metadata are left out`);
  }
  for (const cell of cells) {
    const source = sourceOf(cell).replace(/\s+$/, "");
    parts.push(source === "" ? `%% ${kindOf(cell)}` : `%% ${kindOf(cell)}\n${source}`);
  }
  return parts.join("\n\n") + "\n";
}

/// A file's text as `--text` shows it: the notebook's cells, or the file as
/// it is when it is not a notebook.
export function fileText(raw: string, name?: string): string {
  const json = notebookJson(raw);
  return json === undefined ? raw : notebookText(json.cells, name);
}

/// Where a Markdown cell keeps its live values (`livemarkdown.ts`'s
/// `LIVE_KEY`): an output of a run, so stripped with the outputs.
export const LIVE_VALUES_KEY = "q-lint.liveValues";

/// `raw` without its outputs, run numbers and times and live values, or as
/// it is when it is not a notebook.
export function stripQnb(raw: string): string {
  const json = notebookJson(raw);
  if (json === undefined) {
    return raw;
  }
  for (const cell of json.cells as Json[]) {
    delete cell.outputs;
    delete cell.execution;
    if (isObject(cell.metadata)) {
      delete cell.metadata[LIVE_VALUES_KEY];
      if (Object.keys(cell.metadata).length === 0) {
        delete cell.metadata;
      }
    }
  }
  return JSON.stringify(json, null, 1) + "\n";
}

/// Whether `raw` is a notebook with anything for `stripQnb` to take out.
export function hasOutputs(raw: string): boolean {
  return ((notebookJson(raw)?.cells ?? []) as Json[]).some(
    (cell: Json) => "outputs" in cell || "execution" in cell || (isObject(cell.metadata) && LIVE_VALUES_KEY in cell.metadata),
  );
}

export interface CellDiff {
  /// Cells only in the right-hand notebook, only in the left, and in both
  /// places but with a different source, kind or language.
  added: number;
  removed: number;
  changed: number;
  same: number;
}

/// The most cells compared by their longest common run: above it, each pair
/// is compared by its position.
const ALIGN_LIMIT = 4_000_000;

/// How the cells of `left` became `right`, by the cells' kind, language and
/// source alone. Cells are matched as a diff matches lines (their longest
/// common run); between two matched cells, removed and added cells pair up
/// as changed ones.
export function diffCells(left: readonly CellLike[], right: readonly CellLike[]): CellDiff {
  const key = (c: CellLike): string => `${kindOf(c)}\n${sourceOf(c).replace(/\s+$/, "")}`;
  const a = left.map(key);
  const b = right.map(key);
  const n = a.length;
  const m = b.length;
  const result: CellDiff = { added: 0, removed: 0, changed: 0, same: 0 };
  // A run of removed and added cells between two matched ones.
  const gap = (removed: number, added: number): void => {
    const paired = Math.min(removed, added);
    result.changed += paired;
    result.removed += removed - paired;
    result.added += added - paired;
  };
  if (n * m > ALIGN_LIMIT) {
    for (let i = 0; i < Math.min(n, m); i++) {
      if (a[i] === b[i]) {
        result.same++;
      } else {
        result.changed++;
      }
    }
    gap(Math.max(0, n - m), Math.max(0, m - n));
    return result;
  }
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let removed = 0;
  let added = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      gap(removed, added);
      removed = 0;
      added = 0;
      result.same++;
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      added++;
      j++;
    } else {
      removed++;
      i++;
    }
  }
  gap(removed, added);
  return result;
}

/// `diff` in words: "2 cells changed, 1 added, 0 removed, 5 the same".
export function diffSummary(diff: CellDiff): string {
  if (diff.added + diff.removed + diff.changed === 0) {
    return `no cell changed (${diff.same} the same)`;
  }
  return `${diff.changed} ${diff.changed === 1 ? "cell" : "cells"} changed, ${diff.added} added, ${diff.removed} removed, ${diff.same} the same`;
}

const USAGE = "usage: node qnbgit.js --text NOTEBOOK.qnb | --strip [NOTEBOOK.qnb]";

/// `bytes` stripped, or as they are when they are not UTF-8 or not a
/// notebook (#1560): never decoded and written back changed.
export function stripBytes(bytes: Buffer): Buffer {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return bytes;
  }
  return notebookJson(text) === undefined ? bytes : Buffer.from(stripQnb(text), "utf8");
}

/// The command line: what to write to stdout and stderr, and the exit code.
/// `--strip` with no file reads stdin, as git's clean filter gives it.
export function main(
  argv: string[],
  read: (file: string | 0) => string | Buffer = (f) => fs.readFileSync(f),
): { out: string | Buffer; err: string; code: number } {
  if (argv[0] === "--strip" && argv.length <= 2) {
    try {
      const raw = read(argv[1] ?? 0);
      return { out: typeof raw === "string" ? stripQnb(raw) : stripBytes(raw), err: "", code: 0 };
    } catch (error) {
      return { out: "", err: `qnbgit: ${error instanceof Error ? error.message : String(error)}\n`, code: 2 };
    }
  }
  if (argv[0] === "--text" && argv.length === 2) {
    try {
      return { out: fileText(read(argv[1]).toString()), err: "", code: 0 };
    } catch (error) {
      return { out: "", err: `qnbgit: ${error instanceof Error ? error.message : String(error)}\n`, code: 2 };
    }
  }
  return { out: argv[0] === "--help" ? `${USAGE}\n` : "", err: argv[0] === "--help" ? "" : `${USAGE}\n`, code: argv[0] === "--help" ? 0 : 2 };
}

if (require.main === module) {
  const { out, err, code } = main(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
