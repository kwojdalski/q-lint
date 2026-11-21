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
// The result is the value as the process prints it - `.Q.S` at a fixed
// 2000 by 2000 console, so `\c` does not change it, but `\P` does. KDB-X
// prints no wider than `\c` whatever `.Q.S` is asked, so SNAPSHOT_RUN sets
// it for the query and puts it back, error or not; otherwise the query runs
// as one from the editor does (`query.ts`'s TRAP). Two results are the same
// when their lines are, without trailing blanks.
import { TRAP } from "./query";

export const SNAPSHOT_COMMANDS = {
  record: "q-lint.recordSnapshot",
  update: "q-lint.updateSnapshot",
} as const;

/// Runs the statements `s` and prints the result at a 2000 by 2000
/// console, answering as `query.ts`'s RUN does.
export const SNAPSHOT_RUN = [
  "{[s]",
  " c:system\"c\";system\"c 2000 2000\";",
  ...TRAP,
  " t:$[r 0;@[.Q.S[2000 2000j;0j];r 1;{(0b;x)}];()];",
  " system\"c \",\" \"sv string c;",
  " $[not r 0;`ok`error`trace!(0b;r 1;r 2);0b~first t;`ok`error`trace!(0b;last t;\"\");`ok`type`text!(1b;type r 1;t)]}",
].join("\n");
export const SNAPSHOT_EXTENSION = ".qsnap";
export const SNAPSHOT_DIRECTORY = "__snapshots__";

const HEADER = "// q-lint snapshot";
const QUERY = "// query";
const RESULT = "// result";

export interface Snapshot {
  query: string;
  result: string;
}

/// The file a snapshot is written as.
export function formatSnapshot(snapshot: Snapshot): string {
  return [HEADER, QUERY, snapshot.query.replace(/\s+$/, ""), RESULT, trimmed(snapshot.result), ""].join("\n");
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
  const query = lines.slice(2, at).join("\n").trim();
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
