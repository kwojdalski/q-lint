// Snapshot tests (#981), as data: a query's result recorded as a golden
// file, and checked against it later. Free of any `vscode` import, so node
// tests it; `testexplorer.ts` lists and runs the files, `snapshotview.ts`
// records and updates them.
//
// A snapshot is a text file, `__snapshots__/<name>.qsnap` beside the file
// it was recorded from:
//
//   // q-lint snapshot
//   // query
//   select from t where a>1
//   // result
//   a b
//   ---
//   2 y
//
// A line of the query that is `// result` itself is written `//\ result`
// (and `//\ result` with one more backslash), so the first `// result`
// line is always where the result starts (#1885).
//
// The result is the value as the process prints it - `.Q.S` at a fixed
// 2000 by 2000 console, so `\c` does not change it, but `\P` does. KDB-X
// prints no wider than `\c` whatever `.Q.S` is asked, so SNAPSHOT_RUN sets
// it for the query and puts it back, error or not; otherwise the query runs
// as one from the editor does (`query.ts`'s TRAP). Two results are the same
// when their lines are, without trailing blanks.
import { trapLines } from "./query";

export const SNAPSHOT_COMMANDS = {
  record: "q-lint.recordSnapshot",
  update: "q-lint.updateSnapshot",
} as const;

/// Runs the statements `s` and prints the result at a 2000 by 2000
/// console, answering as `query.ts`'s RUN does.
function snapshotRun(readOnly: boolean): string {
  return [
    "{[s]",
    " c:system\"c\";system\"c 2000 2000\";",
    ...trapLines(readOnly),
    " t:$[r 0;@[.Q.S[2000 2000j;0j];r 1;{(0b;x)}];()];",
    " system\"c \",\" \"sv string c;",
    " $[not r 0;`ok`error`trace!(0b;r 1;r 2);0b~first t;`ok`error`trace!(0b;last t;\"\");`ok`type`text!(1b;type r 1;t)]}",
  ].join("\n");
}

export const SNAPSHOT_RUN = snapshotRun(false);
/// `SNAPSHOT_RUN` under `reval`, sent by `QConnection.trapped` while the
/// read-only guard's backstop is set, as a query is.
export const SNAPSHOT_RUN_READ_ONLY = snapshotRun(true);
export const SNAPSHOT_EXTENSION = ".qsnap";
export const SNAPSHOT_DIRECTORY = "__snapshots__";

const HEADER = "// q-lint snapshot";
const QUERY = "// query";
const RESULT = "// result";

export interface Snapshot {
  query: string;
  result: string;
}

/// A query line that is the result's marker, with any backslashes after
/// its slashes: written with one more, read back with one fewer (#1885).
const MARKER_LINE = /^\/\/(\\*) result$/;

/// The file a snapshot is written as.
export function formatSnapshot(snapshot: Snapshot): string {
  const query = snapshotQuery(snapshot.query)
    .split("\n")
    .map((l) => (MARKER_LINE.test(l) ? `//\\${l.slice(2)}` : l))
    .join("\n");
  return [HEADER, QUERY, query, RESULT, trimmed(snapshot.result), ""].join("\n");
}

/// `query` as a snapshot file holds it and `parseSnapshot` reads it back:
/// with `\n` line ends, as a CRLF document's selection has not (#1415), and
/// no blanks around it.
export function snapshotQuery(query: string): string {
  return query.replace(/\r\n/g, "\n").trim();
}

/// A snapshot file read, or undefined when `text` is not one.
export function parseSnapshot(text: string): Snapshot | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== HEADER || lines[1]?.trim() !== QUERY) {
    return undefined;
  }
  const at = lines.indexOf(RESULT, 2);
  if (at < 0) {
    return undefined;
  }
  const query = lines
    .slice(2, at)
    .map((l) => (MARKER_LINE.test(l) ? `//${l.slice(3)}` : l))
    .join("\n")
    .trim();
  return query === "" ? undefined : { query, result: trimmed(lines.slice(at + 1).join("\n")) };
}

/// `text` without trailing blanks on any line, nor blank lines at its end.
export function trimmed(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/// Why `text`, a result SNAPSHOT_RUN printed, is not all of the value, or
/// undefined when it is: `.Q.S` at 2000 by 2000 ends a longer result with a
/// `..` line and a wider line with `..` at 1999 characters. A change past
/// the cut leaves the text the same, so a snapshot of it would pass (#2454).
export function snapshotCut(text: string[]): string | undefined {
  if (text.length >= 2000 && text[text.length - 1] === "..") {
    return "longer than the 2000 lines a snapshot holds";
  }
  if (text.some((l) => l.length >= 1999 && l.endsWith(".."))) {
    return "wider than the 2000 characters a snapshot's line holds";
  }
  return undefined;
}

/// Whether two results are the same, as a snapshot compares them.
export function sameResult(a: string, b: string): boolean {
  return trimmed(a) === trimmed(b);
}

/// A file name for a snapshot of `query`: its first words, as letters,
/// digits and `_`, at most 40 characters.
export function snapshotName(query: string): string {
  const name = query
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  return name === "" ? "snapshot" : name;
}

/// Whether `name` may name a snapshot file: no separator, no leading dot.
export function validName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && !name.includes("..");
}

/// The first `lines` lines of `text`, for a confirmation's detail.
export function preview(text: string, lines = 20): string {
  const all = text.split("\n");
  return all.length <= lines ? text : [...all.slice(0, lines), `... ${all.length - lines} more lines`].join("\n");
}
