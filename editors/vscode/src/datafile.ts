// Data files in the grid (#962) and the CSV load wizard (#963), as data: a
// file's first lines read as a delimited table, each column's q type guessed
// from them, and the q that loads the file. Free of any `vscode` import, so
// node tests it; `resulttools.ts` reads the file and sends the code.
//
// The load is q's own `0:`, given a type string and the delimiter enlisted,
// so the first line is the header: `("SFJ";enlist",")0:`:/data/t.csv`. q
// reads the file by its path, which only a process on this machine can; for
// one elsewhere, the lines themselves are sent instead, up to a size. JSON
// is `.j.k` of the file's text: an array of objects becomes a table, its
// numbers floats and its strings strings, as `.j.k` makes them.
//
// A type is guessed from at most `SAMPLE_ROWS` rows, leaving out the empty
// cells, which `0:` reads as nulls: a long when every cell is a whole
// number, a float when every one is a number, a date (yyyy.mm.dd or
// yyyy-mm-dd), a timestamp (a date and a time, with `T`, `D` or a space
// between) or a time when each is one, and otherwise a symbol when the
// cells repeat or are short and have no spaces, and a string when they do
// not. A column with no cell to go by is a string. The guess is a start:
// the wizard lets each be changed, or the column skipped.
import { basename } from "node:path";
import { stringLiteral } from "./qliteral";

/// The commands, as `resulttools.ts` registers them.
export const DATA_FILES = {
  open: "q-lint.openDataFile",
  wizard: "q-lint.loadCsvWizard",
} as const;

/// The data file features' settings, `q-lint.dataFiles.<feature>.enable`:
/// each on unless set to false.
export function readDataFiles(get: <T>(key: string, fallback: T) => T): { open: boolean; loadWizard: boolean } {
  return {
    open: get<unknown>("dataFiles.open.enable", true) !== false,
    loadWizard: get<unknown>("dataFiles.loadWizard.enable", true) !== false,
  };
}

/// Rows a type is guessed from.
export const SAMPLE_ROWS = 1000;
/// Bytes of a file read to guess from.
export const SAMPLE_BYTES = 256 * 1024;
/// The largest file whose lines are sent to a process that cannot read it.
export const INLINE_BYTES = 256 * 1024;

/// The types the wizard offers, by the letter `0:` takes; a space skips
/// the column.
export const LOAD_TYPES: { letter: string; name: string }[] = [
  { letter: "S", name: "symbol" },
  { letter: "*", name: "string" },
  { letter: "J", name: "long" },
  { letter: "I", name: "int" },
  { letter: "F", name: "float" },
  { letter: "E", name: "real" },
  { letter: "B", name: "boolean" },
  { letter: "C", name: "char" },
  { letter: "D", name: "date" },
  { letter: "P", name: "timestamp" },
  { letter: "Z", name: "datetime" },
  { letter: "M", name: "month" },
  { letter: "T", name: "time" },
  { letter: "V", name: "second" },
  { letter: "U", name: "minute" },
  { letter: "N", name: "timespan" },
  { letter: "G", name: "guid" },
  { letter: " ", name: "skip this column" },
];

export type DataKind = "csv" | "json";

/// What a file's name says it holds, or undefined for anything else.
export function dataKind(path: string): { kind: DataKind; delimiter: string } | undefined {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext === "csv" ? { kind: "csv", delimiter: "," } : ext === "tsv" || ext === "tab" ? { kind: "csv", delimiter: "\t" } : ext === "json" ? { kind: "json", delimiter: "" } : ext === "txt" || ext === "psv" ? { kind: "csv", delimiter: ext === "psv" ? "|" : "" } : undefined;
}

/// The delimiter a header line most likely uses: the one of `,`, tab, `|`
/// and `;` it holds most of, outside quotes; `,` when it holds none.
export function guessDelimiter(header: string): string {
  let best = ",";
  let most = 0;
  for (const d of [",", "\t", "|", ";"]) {
    const n = splitLine(header, d).length - 1;
    if (n > most) {
      best = d;
      most = n;
    }
  }
  return best;
}

/// One line's fields, a field in double quotes taken whole with `""` read
/// as one quote, as `0:` reads them.
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    let field = "";
    if (line[i] === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += line[i++];
      }
      while (i < line.length && line[i] !== delimiter) {
        field += line[i++];
      }
    } else {
      const at = line.indexOf(delimiter, i);
      const end = at < 0 ? line.length : at;
      field = line.slice(i, end);
      i = end;
    }
    out.push(field);
    if (i >= line.length) {
      return out;
    }
    i++;
  }
}

export interface Sample {
  delimiter: string;
  names: string[];
  /// Up to SAMPLE_ROWS rows, each as many fields as there are names.
  rows: string[][];
  /// Each column's guessed letter.
  types: string[];
}

const LONG = /^[-+]?\d+$/;
const FLOAT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DATE = /^\d{4}[.-]\d{2}[.-]\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
const STAMP = /^\d{4}[.-]\d{2}[.-]\d{2}[T D]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;

/// The letter guessed for a column's cells.
export function guessType(cells: string[]): string {
  const seen = cells.map((c) => c.trim()).filter((c) => c !== "");
  if (seen.length === 0) {
    return "*";
  }
  const all = (re: RegExp) => seen.every((c) => re.test(c));
  if (all(LONG)) {
    // A long that does not fit is read as a null: a float keeps it.
    return seen.every((c) => Math.abs(Number(c)) < 9.2e18) ? "J" : "F";
  }
  if (all(FLOAT)) {
    return "F";
  }
  if (all(DATE)) {
    return "D";
  }
  if (all(STAMP)) {
    return "P";
  }
  if (all(TIME)) {
    return "T";
  }
  const distinct = new Set(seen).size;
  const short = seen.every((c) => c.length <= 16 && !/\s/.test(c));
  return short || distinct * 2 <= seen.length ? "S" : "*";
}

/// The text's first lines as a table: the header, the rows and a guessed
/// type for each column. `delimiter` "" guesses it from the header. `cut`:
/// the text is the start of a longer file, so its last line can be partial.
export function sampleText(text: string, delimiter = "", cut = false): Sample {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines[0] ?? "";
  const d = delimiter === "" ? guessDelimiter(header) : delimiter;
  const names = splitLine(header, d).map((n) => n.trim());
  if (cut && lines.length > 2) {
    lines.pop();
  }
  const body = lines.slice(1, SAMPLE_ROWS + 1).filter((l) => l.trim() !== "");
  const rows = body.slice(0, SAMPLE_ROWS).map((l) => {
    const f = splitLine(l, d);
    return names.map((_, i) => f[i] ?? "");
  });
  const types = names.map((_, i) => guessType(rows.map((r) => r[i])));
  return { delimiter: d, names, rows, types };
}

/// A delimiter as a q char.
function charLiteral(d: string): string {
  return d === "\t" ? '"\\t"' : stringLiteral(d);
}

/// A file's path as the symbol that names its handle: `` `:/a/b.csv ``, or
/// `` `$":/a b/c.csv" `` when the path holds what a bare symbol cannot.
export function fileHandle(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z0-9_./:]+$/.test(p) ? `\`:${p}` : `\`$${stringLiteral(`:${p}`)}`;
}

/// The expression `0:` loads a delimited file with: `types` one letter per
/// column, read from `source` - the file's handle, or a list of its lines.
export function csvLoad(types: string[], delimiter: string, source: string): string {
  return `(${stringLiteral(types.join(""))};enlist ${charLiteral(delimiter)})0:${source}`;
}

/// Lines as a q list of strings, for a process that cannot read the file.
export function linesLiteral(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length === 1 ? `enlist ${stringLiteral(lines[0])}` : `(${lines.map(stringLiteral).join(";")})`;
}

/// The expression that loads a data file: by its path when the process
/// can read it (`local`), or else from its text, which must then be given.
export function loadExpression(kind: DataKind, path: string, local: boolean, sample: Pick<Sample, "types" | "delimiter">, text?: string): string {
  if (kind === "json") {
    return local ? `.j.k raze read0 ${fileHandle(path)}` : `.j.k ${stringLiteral((text ?? "").replace(/\r?\n/g, " "))}`;
  }
  return csvLoad(sample.types, sample.delimiter, local ? fileHandle(path) : linesLiteral(text ?? ""));
}

/// A name for the table a file is loaded as: its base name, made a q name.
export function tableName(path: string): string {
  const base = basename(path.replace(/\\/g, "/")).replace(/\.[^.]*$/, "");
  const name = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]+/, "");
  return name === "" ? "t" : name;
}

/// Whether a process at `host` (reached with no SSH tunnel) runs on this
/// machine, and so can read a file by its path here.
export function isLocalHost(host: string, here: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "" || h === "localhost" || h === "127.0.0.1" || h === "::1" || h === here.trim().toLowerCase();
}
