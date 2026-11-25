// Query controls (#887), as data: the commands and settings, what an
// unlimited and an unwrapped query send and how their answers are read, and
// how a file's own connection is kept and shown. No `vscode` import, so all
// of it is tested with node; `controls.ts` is the VS Code around it.
//
// Unlimited: console text is not cut at `q-lint.output.consoleSize`, and a
// grid or chart is sent every row. q's own formatting still cuts in one
// place: KDB-X's `-3!`, which `.Q.S` writes an atom, a simple list, an item
// of a list, a nested cell and a dictionary's value with, stops at the
// process's `\c` width whatever size is asked for, and `\c` is the
// process's to set, not ours. So `UNLIMITED` sends a simple list itself,
// and it is written here (`qformat.ts`); everything else is the process's
// `.Q.S` at a size nothing reaches, and a value that leaves cut is laid out
// again by `LAID_OUT`, which reads `\c` and never sets it (#1995).
//
// Unwrapped: the code is sent as a plain string, statement by statement, for
// a gateway that refuses a lambda. The process evaluates each as it
// evaluates any string a client sends, and the answer is whatever it
// returns, formatted here.
import { attrText, consoleLines, gridOf, gridOfQ, cutLines, formatQ, formatValue, vectorText } from "./qformat";
import { decode, type QValue } from "./qdecode";
import { readAnswer, trapLines, type Answer } from "./query";
import type { GridAnswer } from "./grid";
import { QError } from "./qclient";
import { iconsEscaped } from "./history";
import { FULL_TEXT, LAID_OUT } from "./qtext";

export const CONTROL_COMMANDS = {
  queryFile: "q-lint.queryEntireFile",
  toggleUnlimited: "q-lint.toggleUnlimitedQuery",
  toggleUnwrapped: "q-lint.toggleUnwrappedQuery",
  chooseFileConnection: "q-lint.chooseConnectionForFile",
  clearFileConnection: "q-lint.clearConnectionForFile",
  startRepl: "q-lint.startRepl",
  copyQuery: "q-lint.copyQuery",
  revealProcess: "q-lint.revealProcess",
  openSettings: "q-lint.openSettings",
} as const;

/// Where a file's connection is kept: `workspaceState`, under this key, as
/// `{ [uri]: label }`.
export const FILE_CONNECTIONS_KEY = "q-lint.fileConnections";

export interface ControlSettings {
  /// Send the code as a plain string, for a gateway that refuses lambdas.
  unwrapped: boolean;
  /// Seconds a query may run before it is aborted; 0: no limit.
  timeout: number;
}

/// The settings read as `readLive` reads the query ones, at each query.
export function readControls(get: <T>(key: string, fallback: T) => T): ControlSettings {
  const timeout = get<unknown>("query.timeout", 0);
  return {
    unwrapped: get<unknown>("query.unwrapped", false) === true,
    // A timer takes at most 2^31-1 ms; a day is plenty.
    timeout: typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 86_400) : 0,
  };
}

/// The console size an unlimited query asks `.Q.S` for: more lines and
/// columns than any result has.
export const UNLIMITED_SIZE: [number, number] = [1e9, 1e9];
/// The rows an unlimited grid or chart asks for: every one.
export const UNLIMITED_ROWS = Number.MAX_SAFE_INTEGER;

/// The console size and grid rows a query asks for.
export function limits(
  settings: { consoleSize: [number, number]; gridLimit: number },
  unlimited: boolean,
): { consoleSize: [number, number]; gridLimit: number } {
  return unlimited
    ? { consoleSize: UNLIMITED_SIZE, gridLimit: UNLIMITED_ROWS }
    : { consoleSize: settings.consoleSize, gridLimit: settings.gridLimit };
}

/// `RUN` for an unlimited console query: the same answer, except that a
/// simple list (types 1 to 19), or an enumerated one's values with its
/// domain, comes as `value`, with no text, for `readUnlimited` to write. A
/// temporal list comes as the numbers q holds it as - timestamps and
/// timespans long nanoseconds, a datetime float days, the rest ints - since
/// the codec would make a timestamp a float, exact only to 256 ns, and loses
/// the sign of a date's infinity. A string comes as its bytes, which the
/// codec would read as UTF-8, losing any that are not. Its attribute comes as
/// `attr`, and the process's `\P` as `precision`, the digits a float is
/// written to. Any other value is `.Q.S`'s lines; when one of them may have
/// been cut at the process's `\c` width - it is that long and holds `..` -
/// the value is `LAID_OUT`'s instead, every row and each cell to its end
/// (#1995). Like `RUN` it defines nothing on the process.
function unlimitedLambda(readOnly: boolean): string {
  return [
    "{[s;size]",
    ...trapLines(readOnly),
    " t:type r 1;",
    " e:$[r[0]&t within 20 76h;@[value;r 1;{()}];()];",
    " $[r 0;",
    "   $[t within 1 19h;`ok`type`text`value`attr`precision!(1b;t;();$[t within 12 19h;\"jiifjiii\"[t-12h]$r 1;t=10h;\"x\"$r 1;r 1];attr r 1;system\"P\");",
    "     (t within 20 76h)&type[e] within 1 19h;`ok`type`text`value`attr`vtype`domain`eattr`precision!(1b;t;();$[type[e] within 12 19h;\"jiifjiii\"[type[e]-12h]$e;e];attr e;type e;key r 1;attr r 1;system\"P\");",
    `     \`ok\`type\`text!(1b;t;{[s;x]$[any(s like"*..*")&(-1+last system"c")<=count each s;"\\n"vs -1_${LAID_OUT}[${FULL_TEXT};0W;x];s]}[.Q.S["j"$size;0j] r 1;r 1])];`,
    "   `ok`error`trace!(0b;r 1;r 2)]}",
  ].join("\n");
}

export const UNLIMITED = unlimitedLambda(false);
/// `UNLIMITED` under `reval` (`trapLines`).
export const UNLIMITED_READ_ONLY = unlimitedLambda(true);

/// The answer `UNLIMITED` gave, as `readAnswer` reads `RUN`'s, a simple list
/// written out whole.
export function readUnlimited(raw: unknown): Answer {
  const answer = readAnswer(raw);
  const r = raw as Record<string, unknown>;
  // The codec drops a list's attribute; q writes it first: `s#1 2 3.
  if (answer.ok && "value" in r && answer.type >= 1 && answer.type <= 19) {
    const precision = typeof r.precision === "number" ? r.precision : 7;
    return { ...answer, text: [vectorText(r.value, answer.type, typeof r.attr === "string" ? r.attr : null, precision)] };
  }
  // An enumerated list, as -3! writes it but whole: `sym$`a`b, its values'
  // attribute after the domain (KDB-X writes `s#`sym$`s#`a`b), and an
  // empty one `sym$().
  if (answer.ok && "domain" in r && typeof r.domain === "string" && typeof r.vtype === "number") {
    const precision = typeof r.precision === "number" ? r.precision : 7;
    const body =
      Array.isArray(r.value) && r.value.length === 0
        ? "()"
        : vectorText(r.value, r.vtype, typeof r.attr === "string" ? r.attr : null, precision);
    return { ...answer, text: [`${attrText(typeof r.eattr === "string" ? r.eattr : null)}\`${r.domain}$${body}`] };
  }
  return answer;
}

/// What `runUnwrapped` needs of a connection.
export interface Evaluator {
  evaluate(text: string): Promise<{ value: unknown; type: number | undefined; message?: Buffer }>;
}

/// Run `statements` unwrapped: each sent as a plain string, in order,
/// stopping at the first q error, and the last one's value shown. Its text
/// is formatted here and cut at `size` unless `unlimited`; when `grid` asks
/// and the value is tabular, its rows (at most `limit`, unless `unlimited`)
/// come too. A q error is the answer's error, with no trace: the process
/// sends none. Anything else - the connection closing, an abort - throws.
export async function runUnwrapped(
  connection: Evaluator,
  statements: string[],
  options: { size: [number, number]; limit: number; unlimited: boolean; grid: boolean },
): Promise<GridAnswer> {
  let last: { value: unknown; type: number | undefined; message?: Buffer } = { value: null, type: 101 };
  for (const statement of statements) {
    try {
      last = await connection.evaluate(statement);
    } catch (error) {
      if (error instanceof QError) {
        return { ok: false, error: error.message, trace: "" };
      }
      throw error;
    }
  }
  // The message read again with its types; what cannot be is written from
  // the codec's value alone.
  let typed: QValue | undefined;
  try {
    typed = last.message === undefined ? undefined : decode(last.message);
  } catch {
    typed = undefined;
  }
  let text: string[];
  if (typed === undefined) {
    const lines = formatValue(last.value, last.type);
    text = options.unlimited ? lines : cutLines(lines, options.size);
  } else {
    text = options.unlimited ? formatQ(typed, last.value, last.type) : consoleLines(typed, options.size, last.value, last.type);
  }
  const answer: GridAnswer = { ok: true, type: last.type ?? 0, text };
  if (!options.grid) {
    return answer;
  }
  // A string is shown as text, as `GRID` shows one.
  const limit = options.unlimited ? Infinity : options.limit;
  const grid =
    typed !== undefined ? gridOfQ(typed, limit) : typeof last.value === "string" ? undefined : gridOf(last.value, last.type, limit);
  return grid === undefined ? answer : { ...answer, grid };
}

/// An untitled editor's process, as its text was when last seen.
export interface UntitledBinding {
  label: string;
  text: string;
  /// When it was seen: closed, or now for one still open.
  at: number;
}

/// The process of the untitled editor a file just saved was saved from:
/// one with the same text, seen within `within` ms. Saving an untitled
/// editor closes it and opens the file, and nothing else links the two
/// (#1529). Undefined for empty text, or when two processes would match,
/// or for a file `opened` - when this window first saw it - longer ago than
/// that: an old file saved with the same text is not the one saved as (#1723).
export function savedFrom(text: string, untitled: readonly UntitledBinding[], now: number, within = 5000, opened?: number): string | undefined {
  if (text.trim() === "" || (opened !== undefined && now - opened > within)) {
    return undefined;
  }
  const labels = new Set(untitled.filter((u) => u.text === text && now - u.at <= within).map((u) => u.label));
  return labels.size === 1 ? [...labels][0] : undefined;
}

/// The process a file is bound to, from what `workspaceState` holds.
export function bindingFor(stored: unknown, uri: string): string | undefined {
  if (typeof stored !== "object" || stored === null) {
    return undefined;
  }
  const label = (stored as Record<string, unknown>)[uri];
  return typeof label === "string" && label !== "" ? label : undefined;
}

/// What `workspaceState` holds once `uri` is bound to `label`, or unbound
/// when `label` is undefined. Entries that are not labels are dropped.
export function withBinding(stored: unknown, uri: string, label: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof stored === "object" && stored !== null) {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") {
        out[k] = v;
      }
    }
  }
  if (label === undefined) {
    delete out[uri];
  } else {
    out[uri] = label;
  }
  return out;
}

/// What the status bar says of the query flags: empty when none is on.
export function flagsText(unlimited: boolean, unwrapped: boolean): string {
  return [unlimited ? "$(unfold) unlimited" : "", unwrapped ? "$(symbol-string) unwrapped" : ""].filter(Boolean).join(" ");
}

/// What the status bar says of the active file's process: undefined when it
/// has none, or it is the active connection.
export function bindingText(bound: string | undefined, active: string | undefined): string | undefined {
  return bound === undefined || bound === active ? undefined : `$(file-symlink-file) file: ${iconsEscaped(bound)}`;
}

/// Run `expire` once `seconds` have passed, unless the function returned is
/// called first; with no timeout (0) it never runs.
export function armTimeout(seconds: number, expire: () => void): () => void {
  if (!(seconds > 0)) {
    return () => {};
  }
  const timer = setTimeout(expire, seconds * 1000);
  return () => clearTimeout(timer);
}

/// How the history says a query timed out.
export function timedOutError(seconds: number): string {
  return `timed out after ${seconds} s`;
}
