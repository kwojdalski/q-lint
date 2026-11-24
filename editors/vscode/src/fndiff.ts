// Function diff between two processes (#1045), as data: one read-only
// lambda that answers a function's definition, or every function directly
// in a namespace with its definition, and the comparison of two such
// answers. Free of any `vscode` import, so node tests it; `fndiffview.ts`
// reads two processes and opens VS Code's diff.
//
// A lambda's definition is `last value f`, the text it was defined from; any
// other function (a projection, a composition, a builtin) is shown as q
// shows it, `-3!f` - whole whatever the process's `\c`, as `FULL_TEXT`
// writes it (#1870). A view is neither, and `get` would evaluate it: it is
// told by its name (#1865). The lambda only reads. Works on kdb+ (KDB-X) and
// PeachQ; held there by processtools_q.test.js.
import { normalized } from "./definitions";
import { isString, listOf } from "./processtools";
import { FULL_TEXT, TEXT_LIMIT } from "./qtext";

export const FUNCTION_TEXTS = [
  "{[nm]",
  " s:`$(),nm;",
  " if[s in views[];:(\"other\";();())];",
  " r:@[{(1b;get x)};s;{(0b;x)}];",
  " if[not first r;:(\"missing\";();())];",
  ` v:last r; txt:{$[100h=type x;last value x;${FULL_TEXT}[${TEXT_LIMIT};x]]};`,
  " if[(type v) within 100 112h;:(\"function\";enlist string s;enlist txt v)];",
  " if[99h=type v;if[11h=type key v;if[(::)~first v;",
  "  k:(key v) except `; f:k where (type each v k) within 100 112h;",
  "  :(\"namespace\";string ` sv' s,'f;txt each v f)]]];",
  " (\"other\";();())}",
].join("\n");

export type Kind = "function" | "namespace" | "missing" | "other";

export interface Texts {
  kind: Kind;
  /// Each function's full name to its definition.
  texts: Map<string, string>;
}

/// What `FUNCTION_TEXTS` answered. Throws when it is not that shape.
export function readTexts(raw: unknown): Texts {
  const p = raw as unknown[];
  const bad = (): never => {
    throw new Error(`the process answered something other than definitions: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  if (!Array.isArray(p) || p.length !== 3 || !["function", "namespace", "missing", "other"].includes(p[0] as string)) {
    return bad();
  }
  const strings = (v: unknown): string[] => (Array.isArray(v) && v.length === 0 ? [] : (listOf(v, isString) ?? bad()));
  const names = strings(p[1]);
  // One function's definition can come as one string where many are a list.
  const texts = names.length === 1 && typeof p[2] === "string" ? [p[2]] : strings(p[2]);
  if (names.length !== texts.length) {
    return bad();
  }
  return { kind: p[0] as Kind, texts: new Map(names.map((n, i) => [n, texts[i]])) };
}

export type Status = "differs" | "same" | "only in first" | "only in second";

export interface Difference {
  name: string;
  status: Status;
}

/// Every function of either side, differing ones first, then those on one
/// side only, then the same; by name within each. Texts compare as drift
/// does, without trailing blanks, which KDB-X drops and PeachQ keeps (#1379).
export function compareTexts(a: Map<string, string>, b: Map<string, string>): Difference[] {
  const rank: Record<Status, number> = { differs: 0, "only in first": 1, "only in second": 2, same: 3 };
  const names = [...new Set([...a.keys(), ...b.keys()])];
  return names
    .map((name): Difference => {
      const x = a.get(name);
      const y = b.get(name);
      return { name, status: x === undefined ? "only in second" : y === undefined ? "only in first" : normalized(x) === normalized(y) ? "same" : "differs" };
    })
    .sort((p, q) => rank[p.status] - rank[q.status] || p.name.localeCompare(q.name));
}

/// The document one side of a diff shows: the definition, or why there is
/// none.
export function sideDocument(name: string, process: string, text: string | undefined): string {
  return text === undefined ? `/ ${name} is not defined on ${process}\n` : text.endsWith("\n") ? text : `${text}\n`;
}

/// The name a command most likely means: a dotted or plain q name.
export function nameProblem(name: string): string | undefined {
  return /^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name.trim()) ? undefined : "a q name, as .lib.f or f";
}
