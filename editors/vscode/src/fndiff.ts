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
import { ORIGINAL } from "./instrument";
import { isString, listOf } from "./processtools";
import { FULL_TEXT, TEXT_LIMIT } from "./qtext";

export const FUNCTION_TEXTS = [
  "{[nm]",
  " s:`$(),nm;",
  " if[s in views[];:(\"other\";();();enlist string s;enlist\"a view\")];",
  " r:@[{(1b;get x)};s;{(0b;x)}];",
  " if[not first r;:(\"missing\";();();();())];",
  // A function q-lint's logpoint is in is read as it was before (#2971).
  ` v:last r; txt:{[n;x]$[100h=type x;last value first ${ORIGINAL}[n;x];${FULL_TEXT}[${TEXT_LIMIT};x]]};`,
  " if[(type v) within 100 112h;:(\"function\";enlist string s;enlist txt[s;v];();())];",
  // What a name that is not a function holds, for the side that has to say
  // so (#2984).
  " what:{t:type x;$[t=98h;\"a table\";t=99h;$[98h=type key x;\"a keyed table\";$[11h=type key x;(::)~first x;0b];\"a namespace\";\"a dictionary\"];t<0;\"an atom of type \",string[t],\"h\";\"a list of type \",string[t],\"h\"]};",
  " if[99h=type v;if[11h=type key v;if[(::)~first v;",
  "  k:(key v) except `; f:k where (type each v k) within 100 112h; o:k except f;",
  "  :(\"namespace\";string ` sv' s,'f;txt'[` sv' s,'f;v f];string s,` sv' s,'o;enlist[\"a namespace\"],what each v o)]]];",
  " (\"other\";();();enlist string s;enlist what v)}",
].join("\n");

export type Kind = "function" | "namespace" | "missing" | "other";

export interface Texts {
  kind: Kind;
  /// Each function's full name to its definition.
  texts: Map<string, string>;
  /// Each name that is not a function to what it holds, as "a table".
  held: Map<string, string>;
}

/// What `FUNCTION_TEXTS` answered. Throws when it is not that shape.
export function readTexts(raw: unknown): Texts {
  const p = raw as unknown[];
  const bad = (): never => {
    throw new Error(`the process answered something other than definitions: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  if (!Array.isArray(p) || (p.length !== 3 && p.length !== 5) || !["function", "namespace", "missing", "other"].includes(p[0] as string)) {
    return bad();
  }
  const strings = (v: unknown): string[] => (Array.isArray(v) && v.length === 0 ? [] : (listOf(v, isString) ?? bad()));
  // One function's definition can come as one string where many are a list.
  const pairs = (keys: unknown, values: unknown): Map<string, string> => {
    const names = strings(keys);
    const texts = names.length === 1 && typeof values === "string" ? [values] : strings(values);
    return names.length === texts.length ? new Map(names.map((n, i) => [n, texts[i]])) : bad();
  };
  return { kind: p[0] as Kind, texts: pairs(p[1], p[2]), held: pairs(p[3] ?? [], p[4] ?? []) };
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
/// none - `held` being what the name is there when it is not a function, a
/// difference of its own that "not defined" hid (#2984).
export function sideDocument(name: string, process: string, text: string | undefined, held?: string): string {
  if (text !== undefined) {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  return held === undefined ? `/ ${name} is not defined on ${process}\n` : `/ ${name} is ${held} on ${process}, not a function\n`;
}

/// The name a command most likely means: a dotted or plain q name.
export function nameProblem(name: string): string | undefined {
  return /^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name.trim()) ? undefined : "a q name, as .lib.f or f";
}
