// The aj match explainer (#1050), as data: an `aj` (or `aj0`) call read
// from the editor, and one lambda that re-runs the match for one row of its
// left table - the right table's rows with that row's keys, then the last of
// them at or before its time, found by `bin` as aj finds it - and says which
// right row it matched, or why none did. Free of any `vscode` import, so
// node tests it; `ajexplainview.ts` sends it and shows the explanation.
//
// The call's three arguments are the user's expressions, evaluated on the
// process, so the lambda is sent through the read-only guard with the call
// as the code it reads. It assigns nothing. Works on kdb+ (KDB-X) and
// PeachQ; held there by processtools_q.test.js.
//
// A row and a time are written by `FULL_TEXT`, up to 2000 characters:
// `.Q.s1` cuts a wide row at the process's `\c` width, short of the columns
// the match turns on (#1908).
import { FULL_TEXT } from "./qtext";

export const EXPLAIN_AJ = [
  "{[c;l;r;i]",
  " c:(),value c; L:0!value l; R:0!value r; i:`long$i;",
  ` F:{2000 sublist x y}${FULL_TEXT}[2000];`,
  " if[not i within(0;-1+count L);'\"no row \",string[i],\" in the left table, which has \",string[count L],\" rows\"];",
  " if[not all c in cols L;'\"the left table has no column \",string first c except cols L];",
  " if[not all c in cols R;'\"the right table has no column \",string first c except cols R];",
  " ks:-1_c; tc:last c; row:L i;",
  " w:til count R; miss:`; k:0;",
  " while[(k<count ks)&0<count w; w:w where(R[ks k] w)=row ks k; if[0=count w;miss:ks k]; k+:1];",
  " tm:R[tc] w; j:$[count w;tm bin row tc;-1];",
  " (F row;\"f\"$count w;string miss;$[null miss;\"\";F row miss];$[j<0;-1f;\"f\"$w j];$[j<0;\"\";F R w j];$[count w;F first tm;\"\"];F row tc;tm~asc tm;string tc;\"f\"$count R)}",
].join("\n");

export interface AjCall {
  fn: "aj" | "aj0";
  columns: string;
  left: string;
  right: string;
}

/// The top-level arguments of a bracketed call starting at `open`, or
/// undefined when its brackets do not close.
function args(code: string, open: number): { parts: string[]; end: number } | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      for (i++; i < code.length && code[i] !== '"'; i++) {
        if (code[i] === "\\") {
          i++;
        }
      }
    } else if (c === "[" || c === "(" || c === "{") {
      depth++;
    } else if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) {
        parts.push(code.slice(start, i).trim());
        return { parts, end: i };
      }
    } else if (c === ";" && depth === 1) {
      parts.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/// The first `aj[cols;left;right]` or `aj0[...]` call in `code`, its
/// arguments as written; undefined when there is none.
export function findAj(code: string): AjCall | undefined {
  for (const m of code.matchAll(/(?:^|[^A-Za-z0-9_.`])(aj0?)\s*\[/g)) {
    const open = m.index! + m[0].length - 1;
    const got = args(code, open);
    if (got !== undefined && got.parts.length === 3 && got.parts.every((p) => p !== "")) {
      return { fn: m[1] as AjCall["fn"], columns: got.parts[0], left: got.parts[1], right: got.parts[2] };
    }
  }
  return undefined;
}

export interface AjMatch {
  /// The left row, as q shows it.
  row: string;
  /// Right rows with the row's keys.
  candidates: number;
  /// The key no right row matched, and the row's value of it; empty when
  /// every key matched.
  missedKey: string;
  missedValue: string;
  /// The right row matched, or -1.
  matched: number;
  matchedRow: string;
  /// The earliest candidate's time.
  earliest: string;
  /// The left row's time.
  time: string;
  /// Whether the candidates are in time order, as aj's search assumes.
  sorted: boolean;
  timeColumn: string;
  rightRows: number;
}

/// What `EXPLAIN_AJ` answered. Throws when it is not that shape.
export function readMatch(raw: unknown): AjMatch {
  const p = raw as unknown[];
  const s = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && v.length === 0 ? "" : undefined);
  const strings = [0, 2, 3, 5, 6, 7, 9].map((i) => s(p?.[i]));
  if (!Array.isArray(p) || p.length !== 11 || strings.some((x) => x === undefined) || typeof p[1] !== "number" || typeof p[4] !== "number" || typeof p[8] !== "boolean" || typeof p[10] !== "number") {
    throw new Error(`the process answered something other than a match: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const [row, missedKey, missedValue, matchedRow, earliest, time, timeColumn] = strings as string[];
  return { row, candidates: p[1], missedKey, missedValue, matched: p[4], matchedRow, earliest, time, sorted: p[8], timeColumn, rightRows: p[10] };
}

/// The explanation, as plain text lines.
export function explain(call: AjCall, index: number, process: string, m: AjMatch): string {
  const lines = [`/ ${call.fn}[${call.columns};${call.left};${call.right}] on ${process}: row ${index} of ${call.left}`, "", `left row ${index}: ${m.row}`, ""];
  if (m.rightRows === 0) {
    // No row to be the earliest and no key that missed (#1909).
    lines.push(`No match: ${call.right} has no rows.`, `${call.fn} leaves the right table's columns null in this row${call.fn === "aj0" ? "" : ", keeping the left row's own"}.`);
  } else if (m.missedKey !== "") {
    lines.push(
      `No match: none of the ${m.rightRows} rows of ${call.right} has ${m.missedKey} = ${m.missedValue}.`,
      `${call.fn} leaves the right table's columns null in this row${call.fn === "aj0" ? "" : ", keeping the left row's own"}.`,
    );
  } else if (m.matched < 0) {
    lines.push(
      `No match: ${m.candidates} row${m.candidates === 1 ? "" : "s"} of ${call.right} ${m.candidates === 1 ? "has" : "have"} the same keys, but the earliest, at ${m.timeColumn} = ${m.earliest}, is after this row's ${m.timeColumn} = ${m.time}.`,
      `${call.fn} matches the last right row at or before the left row's time, so there is none to take.`,
    );
  } else {
    lines.push(
      `Matched row ${m.matched} of ${call.right}: ${m.matchedRow}`,
      "",
      `It is the last of the ${m.candidates} row${m.candidates === 1 ? "" : "s"} with the same keys whose ${m.timeColumn} is at or before ${m.time}.`,
      call.fn === "aj0" ? `aj0 takes the right row's ${m.timeColumn}.` : `aj keeps the left row's ${m.timeColumn}; aj0 would take the right row's.`,
    );
  }
  if (!m.sorted) {
    lines.push(
      "",
      `Warning: those ${m.candidates} rows of ${call.right} are not in ${m.timeColumn} order. aj finds the row by binary search, which assumes they are, so its answer is not reliable: sort ${call.right} by its keys and ${m.timeColumn} first.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
