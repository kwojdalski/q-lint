// The process file browser (#1044), as data: the q host's directories read
// through the process - `key` on a path, as qStudio's remote folder does,
// for a host reached only over q - and a file's first bytes read with
// `read1`, capped, so a large file is never pulled whole. Free of any
// `vscode` import, so node tests it; `remotefilesview.ts` shows them.
//
// Each lambda only reads: none writes a file, assigns a global or runs a
// system command (the working directory is `system"cd"` with no argument,
// which reads it). Paths arrive as strings and are made symbols there
// (`AS_FILE`), each character kept.
// Works on kdb+ (KDB-X) and PeachQ; held there by processtools_q.test.js.
import { isBoolean, isNumber, isString, listOf } from "./processtools";

/// The most entries one directory lists.
export const LIST_LIMIT = 1000;
/// The most bytes of a file shown.
export const FILE_LIMIT = 1024 * 1024;

export const WORKING_DIRECTORY = "{[x] system\"cd\"}";

/// A path's text as a file symbol. q's cast trims the blanks at both ends
/// of a text, and `` ` sv `` of symbols does too, so a name it would change
/// - one `key` answered that ends in a blank - is read as a symbol off the
/// wire is (`-9!`), which keeps every character (#2011).
const AS_FILE = '{[t]s:`$t;hsym $[t~string s;s;-9!0x01000000,(reverse 0x0 vs "i"$10+count t),0xf5,("x"$t),0x00]}';

export const LIST_DIRECTORY = [
  "{[p;lim]",
  ` y:${AS_FILE}; p:(),p; k:key y p;`,
  " if[not 11h=type k;'$[()~k;\"no such directory\";\"not a directory\"]];",
  " n:count k; k:(`long$lim) sublist asc k;",
  " f:y each ($[\"/\"=last p;p;p,\"/\"]),/:string k;",
  " isf:{@[{-11h=type key x};x;0b]} each f;",
  " sz:{@[{$[-11h=type key x;hcount x;-1]};x;-2]} each f;",
  " (string k;isf;\"f\"$sz;\"f\"$n)}",
].join("\n");

/// A file's first `cap` bytes at most. A cut that falls inside a UTF-8
/// character - a lead byte in the last four that promises more bytes than
/// were read - ends before it, so the text shown ends with a character
/// the file holds (#1930).
export const READ_FILE = [
  "{[p;cap]",
  ` f:${AS_FILE}(),p;`,
  " if[not -11h=type key f;'\"not a file\"];",
  " n:hcount f; m:(`long$cap)&n;",
  " b:$[m=0;`byte$();read1(f;0;m)];",
  " if[m<n;",
  "  t:`long$-4 sublist b; w:where not 2=t div 64;",
  "  if[0<count w;",
  "   i:last w; l:t i;",
  "   if[((count t)-i)<$[l<192;1;l<224;2;l<240;3;l<248;4;1]; b:(i-count t)_b]]];",
  " (\"f\"$n;\"c\"$b;m<n;\"f\"$count b)}",
].join("\n");

export interface Entry {
  name: string;
  file: boolean;
  /// Bytes; -1 for a directory, -2 for one the process cannot read.
  size: number;
}

export interface Listing {
  entries: Entry[];
  /// Entries in the directory, listed or not.
  total: number;
}

const bad = (what: string, raw: unknown): never => {
  throw new Error(`the process answered something other than ${what}: ${JSON.stringify(raw)?.slice(0, 200)}`);
};

/// What `LIST_DIRECTORY` answered. Throws when it is not that shape.
export function readListing(raw: unknown): Listing {
  const p = raw as unknown[];
  if (!Array.isArray(p) || p.length !== 4 || typeof p[3] !== "number") {
    return bad("a directory listing", raw);
  }
  const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
  const files = empty(p[1]) ? [] : listOf(p[1], isBoolean);
  const one = files?.length === 1;
  const names = empty(p[0]) ? [] : one && isString(p[0]) ? [p[0]] : listOf(p[0], isString);
  const sizes = empty(p[2]) ? [] : listOf(p[2], isNumber);
  if (files === undefined || names === undefined || sizes === undefined || names.length !== files.length || sizes.length !== files.length) {
    return bad("a directory listing", raw);
  }
  return { entries: names.map((name, i) => ({ name, file: files[i], size: sizes[i] })), total: p[3] };
}

export interface FileHead {
  /// The whole file's bytes.
  size: number;
  text: string;
  /// Whether only the first `shown` bytes were read.
  cut: boolean;
  shown: number;
}

/// What `READ_FILE` answered.
export function readFileHead(raw: unknown): FileHead {
  const p = raw as unknown[];
  if (
    !Array.isArray(p) ||
    p.length !== 4 ||
    typeof p[0] !== "number" ||
    !(typeof p[1] === "string" || (Array.isArray(p[1]) && p[1].length === 0)) ||
    typeof p[2] !== "boolean" ||
    typeof p[3] !== "number"
  ) {
    return bad("a file", raw);
  }
  return { size: p[0], text: typeof p[1] === "string" ? p[1] : "", cut: p[2], shown: p[3] };
}

/// `name` under the directory `dir`, as the host spells paths.
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/// The document a file is shown as: its text, or why it is not shown, and
/// a last line saying it was cut.
export function fileDocument(path: string, process: string, head: FileHead): string {
  if (head.text.includes("\u0000")) {
    return `/ ${path} on ${process}: a binary file of ${head.size} bytes; not shown.\n`;
  }
  return head.cut
    ? `${head.text}\n\n/ q-lint: the first ${head.shown} of ${head.size} bytes of ${path} on ${process}; the rest is not read.\n`
    : head.text;
}
