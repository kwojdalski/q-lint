// The `.qnb` notebook file, and a notebook written out as a q script; free of
// any `vscode` import so a test can read and write one.
//
// A `.qnb` is JSON:
//
//   {
//     "qnb": 1,
//     "cells": [
//       {"kind": "markdown", "source": ["# Prices"]},
//       {"kind": "code", "source": ["/ @grid", "select from t"],
//        "execution": {"order": 1, "success": true, "start": 1700000000000, "end": 1700000000012},
//        "outputs": [{"items": [{"mime": "text/plain", "text": "..."}]}]}
//     ]
//   }
//
// `qnb` is the format's version. `source` is the cell's lines, so a change to
// one line is a change to one line of the file. A code cell is q unless it
// names a `language`. An output item is `text` when its bytes are UTF-8 and
// `base64` otherwise. `execution`, `outputs` and `metadata` are written only
// when there is something in them. A field this extension does not know,
// on the file, a cell, an output, an item or a run, is kept and written
// back after the ones it does; so is a `metadata` that is no object, and
// the `base64` of an item that has a `text` too, which are not read
// (#2993). Saving what was opened gives the same file back.
//
// A file that is not one is refused with what is wrong with it, never read as
// an empty notebook that a save would then write over it.

import { blockDepth, statements } from "./statements";

/// The format this extension writes, and the newest it reads.
export const QNB_VERSION = 1;

export const NOTEBOOK = {
  type: "q-lint-notebook",
  controller: "q-lint-notebook-kernel",
  exportCommand: "q-lint.exportNotebook",
  exportHtmlCommand: "q-lint.exportNotebookHtml",
  exportIpynbCommand: "q-lint.exportNotebookIpynb",
  importIpynbCommand: "q-lint.importIpynb",
  runWithParameters: "q-lint.runNotebookWithParameters",
  refreshVariables: "q-lint.refreshNotebookVariables",
  variablesView: "q-lint.notebookVariables",
  diffCommand: "q-lint.diffNotebook",
  stripCommand: "q-lint.stripNotebookOutputs",
  stripFilterCommand: "q-lint.setUpNotebookStripFilter",
  restartRunAll: "q-lint.restartNotebookAndRunAll",
  /// The renderer that draws a `/ @chart` cell's output.
  renderer: "q-lint.chart",
  /// The Markdown renderer's extension that shows live values.
  liveRenderer: "q-lint.liveMarkdown",
} as const;

export interface QnbItem {
  mime: string;
  /// The item's bytes as UTF-8 text, or as base64 when they are not UTF-8.
  text?: string;
  base64?: string;
  /// The item's fields this extension does not know, kept for the save.
  extra?: Record<string, unknown>;
}

export interface QnbOutput {
  items: QnbItem[];
  metadata?: Record<string, unknown>;
  /// The output's fields this extension does not know, kept for the save.
  extra?: Record<string, unknown>;
}

export interface QnbExecution {
  order?: number;
  success?: boolean;
  /// Milliseconds since the epoch, as VS Code records them.
  start?: number;
  end?: number;
  /// The run's fields this extension does not know, kept for the save.
  extra?: Record<string, unknown>;
}

export interface QnbCell {
  kind: "code" | "markdown";
  source: string;
  /// A code cell's language, when it is not q.
  language?: string;
  outputs?: QnbOutput[];
  execution?: QnbExecution;
  metadata?: Record<string, unknown>;
  /// The cell's fields this extension does not know, kept for the save.
  extra?: Record<string, unknown>;
}

export interface Qnb {
  cells: QnbCell[];
  metadata?: Record<string, unknown>;
  /// The file's fields this extension does not know, kept for the save.
  extra?: Record<string, unknown>;
}

export class QnbError extends Error {}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const FILE_FIELDS = ["qnb", "cells", "metadata"];
const CELL_FIELDS = ["kind", "source", "language", "outputs", "execution", "metadata"];
/// A markdown cell has no language of its own: one in the file is kept as is.
const MARKDOWN_FIELDS = CELL_FIELDS.filter((f) => f !== "language");
const OUTPUT_FIELDS = ["items", "metadata"];
const ITEM_FIELDS = ["mime", "text", "base64"];
const EXECUTION_FIELDS = ["order", "success", "start", "end"];

/// The known fields a file may hold in a shape that is not read, where one
/// of any other is refused: a `metadata` that is no object, and an item's
/// `text` or `base64` beside the one that is its bytes. Each is kept as it
/// was for the save, which dropped it (#2993).
const LOOSE = ["metadata", "text", "base64"];

/// The fields of `json` not in `known`, and the loose ones `read` did not
/// take, as `{extra}`, or nothing when none.
function unknown(json: Json, known: string[], read: object = {}): { extra?: Json } {
  const extra = Object.fromEntries(Object.entries(json).filter(([key]) => !known.includes(key) || (LOOSE.includes(key) && !(key in read))));
  return Object.keys(extra).length > 0 ? { extra } : {};
}

/// `extra`'s fields added to `out`, less any `out` has a field of its own
/// for: a known one is written from `extra` only when it is a loose one
/// `out` does not have.
function withExtra(out: Json, extra: Json | undefined, known: string[]): Json {
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!known.includes(key) || (LOOSE.includes(key) && !(key in out))) {
      out[key] = value;
    }
  }
  return out;
}

/// `JSON.parse`'s reviver: an integer too big for a number kept as its text,
/// which `JSON.stringify` writes back as it was (#1562), where the runtime
/// has `JSON.rawJSON`.
export function lossless(_key: string, value: unknown, context?: { source?: string }): unknown {
  const raw = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
  return typeof value === "number" && !Number.isSafeInteger(value) && raw !== undefined && /^-?\d+$/.test(context?.source ?? "") ? raw(context?.source ?? "") : value;
}

/// Read a `.qnb`. An empty file is a new, empty notebook; anything else that
/// is not a notebook throws a `QnbError` saying where it is wrong. A byte
/// order mark in front, which JSON does not allow, is skipped.
/// `exact: false` reads every number as a number, for the editor, which
/// holds no other kind: VS Code rounds a big integer there.
export function parseQnb(raw: string, exact = true): Qnb {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  if (text.trim() === "") {
    return { cells: [] };
  }
  let json: unknown;
  try {
    json = exact ? JSON.parse(text, lossless) : JSON.parse(text);
  } catch (error) {
    throw new QnbError(`not a q notebook: the file is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isObject(json)) {
    throw new QnbError("not a q notebook: expected a JSON object with \"qnb\" and \"cells\"");
  }
  const version = json.qnb;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new QnbError("not a q notebook: \"qnb\", the format version, is missing or not a whole number");
  }
  if (version > QNB_VERSION) {
    throw new QnbError(`this notebook is format ${version}, written by a newer q-lint; this one reads format ${QNB_VERSION}`);
  }
  if (!Array.isArray(json.cells)) {
    throw new QnbError("not a q notebook: \"cells\" is missing or not a list");
  }
  const cells = json.cells.map((cell, i) => readCell(cell, `cell ${i + 1}`));
  const notebook: Qnb = { cells, ...(isObject(json.metadata) ? { metadata: json.metadata } : {}) };
  return { ...notebook, ...unknown(json, FILE_FIELDS, notebook) };
}

function readCell(raw: unknown, where: string): QnbCell {
  if (!isObject(raw)) {
    throw new QnbError(`${where} is not an object`);
  }
  if (raw.kind !== "code" && raw.kind !== "markdown") {
    throw new QnbError(`${where}: "kind" is ${JSON.stringify(raw.kind)}; a cell is "code" or "markdown"`);
  }
  let source: string;
  if (typeof raw.source === "string") {
    source = raw.source;
  } else if (Array.isArray(raw.source) && raw.source.every((l) => typeof l === "string")) {
    // A line ending in "\n", as Jupyter writes one, would read as two and
    // save as two (#2403): refused, as a save could not give it back.
    const broken = raw.source.findIndex((l) => l.includes("\n"));
    if (broken >= 0) {
      throw new QnbError(`${where}: line ${broken + 1} of "source" holds a line end; a .qnb writes each line without one (a Jupyter notebook is read by Import Jupyter Notebook as q Notebook)`);
    }
    source = raw.source.join("\n");
  } else {
    throw new QnbError(`${where}: "source" is not a list of lines`);
  }
  const cell: QnbCell = { kind: raw.kind, source };
  if (raw.language !== undefined && raw.kind === "code") {
    if (typeof raw.language !== "string") {
      throw new QnbError(`${where}: "language" is not a string`);
    }
    cell.language = raw.language;
  }
  if (raw.outputs !== undefined) {
    if (!Array.isArray(raw.outputs)) {
      throw new QnbError(`${where}: "outputs" is not a list`);
    }
    cell.outputs = raw.outputs.map((output, j) => readOutput(output, `${where}, output ${j + 1}`));
  }
  if (raw.execution !== undefined) {
    if (!isObject(raw.execution)) {
      throw new QnbError(`${where}: "execution" is not an object`);
    }
    const e = raw.execution;
    const execution: QnbExecution = {};
    for (const key of ["order", "start", "end"] as const) {
      if (e[key] !== undefined) {
        if (typeof e[key] !== "number") {
          throw new QnbError(`${where}: "execution.${key}" is not a number`);
        }
        execution[key] = e[key] as number;
      }
    }
    if (e.success !== undefined) {
      if (typeof e.success !== "boolean") {
        throw new QnbError(`${where}: "execution.success" is not true or false`);
      }
      execution.success = e.success;
    }
    cell.execution = { ...execution, ...unknown(e, EXECUTION_FIELDS) };
  }
  if (isObject(raw.metadata)) {
    cell.metadata = raw.metadata;
  }
  return { ...cell, ...unknown(raw, raw.kind === "code" ? CELL_FIELDS : MARKDOWN_FIELDS, cell) };
}

function readOutput(raw: unknown, where: string): QnbOutput {
  if (!isObject(raw) || !Array.isArray(raw.items)) {
    throw new QnbError(`${where} has no "items" list`);
  }
  const items = raw.items.map((item, k): QnbItem => {
    if (!isObject(item) || typeof item.mime !== "string") {
      throw new QnbError(`${where}, item ${k + 1} has no "mime"`);
    }
    let read: QnbItem;
    if (typeof item.text === "string") {
      read = { mime: item.mime, text: item.text };
    } else if (typeof item.base64 === "string") {
      read = { mime: item.mime, base64: item.base64 };
    } else {
      throw new QnbError(`${where}, item ${k + 1} has neither "text" nor "base64"`);
    }
    return { ...read, ...unknown(item, ITEM_FIELDS, read) };
  });
  const output: QnbOutput = { items, ...(isObject(raw.metadata) ? { metadata: raw.metadata } : {}) };
  return { ...output, ...unknown(raw, OUTPUT_FIELDS, output) };
}

/// Write a `.qnb`: keys in a fixed order, one space of indent, a final newline.
export function serializeQnb(notebook: Qnb): string {
  const cells = notebook.cells.map((cell) => {
    const out: Json = { kind: cell.kind, source: cell.source.split("\n") };
    if (cell.language !== undefined && cell.language !== "q" && cell.kind === "code") {
      out.language = cell.language;
    }
    if (cell.execution !== undefined) {
      const { order, success, start, end } = cell.execution;
      const execution = withExtra(
        Object.fromEntries(Object.entries({ order, success, start, end }).filter(([, v]) => v !== undefined)),
        cell.execution.extra,
        EXECUTION_FIELDS,
      );
      if (Object.keys(execution).length > 0) {
        out.execution = execution;
      }
    }
    if (cell.outputs !== undefined && cell.outputs.length > 0) {
      out.outputs = cell.outputs.map((o) =>
        withExtra(
          {
            items: o.items.map((i) =>
              withExtra(i.text !== undefined ? { mime: i.mime, text: i.text } : { mime: i.mime, base64: i.base64 }, i.extra, ITEM_FIELDS),
            ),
            ...(o.metadata !== undefined && Object.keys(o.metadata).length > 0 ? { metadata: o.metadata } : {}),
          },
          o.extra,
          OUTPUT_FIELDS,
        ),
      );
    }
    if (cell.metadata !== undefined && Object.keys(cell.metadata).length > 0) {
      out.metadata = cell.metadata;
    }
    return withExtra(out, cell.extra, cell.kind === "code" ? CELL_FIELDS : MARKDOWN_FIELDS);
  });
  const file: Json = { qnb: QNB_VERSION, cells };
  if (notebook.metadata !== undefined && Object.keys(notebook.metadata).length > 0) {
    file.metadata = notebook.metadata;
  }
  return JSON.stringify(withExtra(file, notebook.extra, FILE_FIELDS), null, 1) + "\n";
}

/// An output item's bytes as the file keeps them: text when they are UTF-8.
export function encodeItem(mime: string, data: Uint8Array): QnbItem {
  const text = Buffer.from(data).toString("utf8");
  return Buffer.from(text, "utf8").equals(Buffer.from(data))
    ? { mime, text }
    : { mime, base64: Buffer.from(data).toString("base64") };
}

export function decodeItem(item: QnbItem): Uint8Array {
  return item.text !== undefined ? Buffer.from(item.text, "utf8") : Buffer.from(item.base64 ?? "", "base64");
}

// --- export

const trimEnd = (line: string): string => line.replace(/\s+$/, "");

/// A code cell as a script runs it the way the cell runs: q reads a script
/// as `statements.ts` reads a cell, but across cells, so what one cell leaves
/// open would change the next. An indented first code line would continue
/// the cell above, and is unindented, as are the comments over it - a lone
/// `/` or `\` there made a line comment; a block comment the cell leaves open is
/// closed; a lone `\`, which ends the cell's code, would end the script, and
/// opens a block comment over the rest of the cell instead. Block comments
/// nest, in a cell as in KDB-X (#1462), so each level the cell leaves open is
/// closed by a `\` of its own (#1731).
function scriptCell(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let ended = false;
  let first = true;
  for (const line of source.split(/\r?\n/)) {
    const text = trimEnd(line);
    if (ended) {
      // Commented out, so a lone `\` here must not close the comment.
      out.push(text === "\\" || text === "/" ? ` ${line}` : line);
      continue;
    }
    if (depth > 0) {
      depth = blockDepth(depth, text);
      out.push(line);
      continue;
    }
    if (text === "/") {
      depth = 1;
    } else if (text === "\\") {
      ended = true;
      out.push("/");
      continue;
    } else if (first && text !== "" && !text.startsWith("/")) {
      const unindented = line.trimStart();
      if (trimEnd(unindented) === "/" || trimEnd(unindented) === "\\") {
        // Unindented, a lone `/` would open a block comment and a lone `\`
        // end the script, losing every later cell (#1563): a line comment.
        out.push(`/ ${unindented}`);
        continue;
      }
      if (unindented.startsWith("/")) {
        // A comment, not the cell's first code line: that one is still to
        // come, and left indented would continue the cell above (#1935).
        out.push(unindented);
        continue;
      }
      first = false;
      out.push(unindented);
      continue;
    }
    out.push(line);
  }
  for (let level = depth + (ended ? 1 : 0); level > 0; level--) {
    out.push("\\");
  }
  return out;
}

/// A markdown cell as a block comment: `/` alone, its lines, `\` alone. A
/// line of the cell that is a lone `\` would close the comment, and a lone
/// `/` open another in KDB-X, so each is indented by a space.
function commentCell(source: string): string[] {
  const lines = source.split(/\r?\n/).map((line) => (trimEnd(line) === "\\" || trimEnd(line) === "/" ? ` ${line}` : line));
  return ["/", ...lines, "\\"];
}

/// `code` as its strings, unescaped and in order, and the rest of it: its
/// text without them and without its comments.
function strings(code: string): { bare: string; quoted: string[] } {
  const quoted: string[] = [];
  let bare = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      let body = "";
      for (i++; i < code.length && code[i] !== '"'; i++) {
        if (code[i] === "\\" && i + 1 < code.length) {
          i++;
          body += { n: "\n", t: "\t", r: "\r" }[code[i]] ?? code[i];
        } else {
          body += code[i];
        }
      }
      quoted.push(body);
      bare += " ";
    } else if (c === "/" && (i === 0 || code[i - 1] === " " || code[i - 1] === "\t" || code[i - 1] === "\n")) {
      const end = code.indexOf("\n", i);
      i = (end < 0 ? code.length : end) - 1;
    } else {
      bare += c;
    }
  }
  return { bare, quoted };
}

// `\d .ns` as q reads the line: after any `q)` or `k)` prompts (#2999).
const CONTEXT_COMMAND = /^(?:[qkK]\))*\\d\s+(\S+)([^]*)$/;

/// Whether `code`, read after a context that was `away` from the root or
/// not, leaves q in a namespace, by the strings in it: a `"d .ns"` where
/// `system` is applied - however: `system "d .ns"`, `system("d .ns")`,
/// `@[system;"d .ns";h]`, in a lambda - and a `"\\d .ns"`, which `value`
/// runs. One built from parts (`system "d ",ns`) may name any. Code inside
/// a string is read the same way, as in `value "system \"d .ns\""`. A
/// string that names the root puts q back there only where something is
/// seen to run it.
function leftBy(code: string, away: boolean): boolean {
  const { bare, quoted } = strings(code);
  const system = /\bsystem\b/.test(bare);
  const run = system || /\b(?:value|get|eval|reval)\b/.test(bare);
  for (const text of quoted) {
    const switched = CONTEXT_COMMAND.exec(text) ?? (system ? /^d[ \t]+(\S*)([^]*)$/.exec(text) : null);
    if (switched !== null) {
      away = switched[1] !== "." || switched[2].trim() !== "" || (away && !run);
    } else if (/\\d\s|\bsystem\b/.test(text)) {
      away = leftBy(text, away);
    }
  }
  return away;
}

/// Whether the cell's code ends in a namespace other than the root: its last
/// `\d` or `system "d ..."` names one. A notebook runs each cell in the root,
/// so the `\d` ends with the cell; a script would carry it into every cell
/// below, whose names would then land in that namespace (#1934). Read from
/// the text: a namespace set inside a function the cell calls is not seen.
/// A `\d` statement's lines after its first, even a comment, are its
/// argument to q, so `\d .` and an indented line is no root (#2155).
/// Every way of writing the switch that KDB-X takes in a script counts
/// (#2999) - `q)\d .ns`, `k)\d .ns`, `system("d .ns")`,
/// `@[system;"d .ns";h]`, `value "\\d .ns"` - and one that only may run
/// does too: a `\d .` the script did not need changes nothing.
export function leavesNamespace(source: string): boolean {
  let away = false;
  for (const statement of statements(source)) {
    const command = CONTEXT_COMMAND.exec(statement);
    away = command !== null ? command[1] !== "." || command[2].trim() !== "" : leftBy(statement, away);
  }
  return away;
}

/// The notebook as a q script q can load: code cells as they run, markdown
/// cells as comments, a blank line between cells. Outputs are left out. A
/// cell that ends in another namespace is followed by `\d .`.
export function exportScript(cells: readonly Pick<QnbCell, "kind" | "source" | "language">[], name?: string): string {
  const parts: string[][] = [];
  if (name !== undefined) {
    parts.push([`/ Exported by q-lint from ${name}.`]);
  }
  for (const cell of cells) {
    if (cell.source.trim() === "") {
      continue;
    }
    if (cell.kind === "markdown") {
      parts.push(commentCell(cell.source));
    } else if (cell.language === undefined || cell.language === "q") {
      parts.push(leavesNamespace(cell.source) ? [...scriptCell(cell.source), "\\d ."] : scriptCell(cell.source));
    } else {
      // Not q: kept, as a comment, so nothing of the notebook is lost.
      parts.push(commentCell(`${cell.language} cell:\n${cell.source}`));
    }
  }
  return parts.map((p) => p.join("\n")).join("\n\n") + "\n";
}
