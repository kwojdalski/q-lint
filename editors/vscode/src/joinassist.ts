// The join assistant (#1049), as data: two tables' shapes - columns, types,
// attributes, keys, and where they live - read from the process, and the
// joins they allow: `lj` and `ij` on the right one's keys, `uj` for tables
// alike, `aj` and `wj` on a time column, each written with the keys and the
// sorts it needs. Free of any `vscode` import, so node tests it;
// `joinassistview.ts` asks and writes the expression.
//
// `TABLE_SHAPE` evaluates the expression it is given - a table's name or a
// query - and reads only its `meta` and keys, so a partitioned table is not
// pulled into memory. The expression is the user's, so it is sent through
// the read-only guard. Works on kdb+ (KDB-X) and PeachQ; held there by
// processtools_q.test.js.
import { qName } from "./explorer";
import { valued, type GuardCode } from "./guard";
import { isString, listOf } from "./processtools";
import { symbolLiteral } from "./qliteral";
import { EVALUATE, type Evaluate } from "./query";

export const TABLES = "{[x] string asc tables[]}";

/// A table picked from `TABLES` as the expression that reads it: its name,
/// or `` get`$"my trade" `` for one q would not parse as a name (#1572).
export const tableExpression = (name: string): string => qName(name);

/// `TABLE_SHAPE` with the expression evaluated by `evaluate`'s `value`:
/// under `reval` on a guarded process (`QConnection.guarded`), so a write
/// in it the guard missed is refused (#2640).
export function tableShapeLambda(evaluate: Evaluate): string {
  return [
    "{[e]",
    " if[(`$e)in views[];'\"a view, not a table\"];",
    ` t:${evaluate.value} e; if[not .Q.qt t;'\"not a table\"];`,
    " m:0!meta t; p:.Q.qp t;",
    " (string m`c;m`t;string m`a;string keys t;$[1b~p;\"partitioned\";0b~p;\"splayed\";\"memory\"])}",
  ].join("\n");
}

export const TABLE_SHAPE = tableShapeLambda(EVALUATE);

export interface Shape {
  expression: string;
  columns: string[];
  /// q's type letter of each column.
  types: string;
  attributes: string[];
  keys: string[];
  where: "memory" | "splayed" | "partitioned";
}

/// What `TABLE_SHAPE` answered for `expression`.
/// What the read-only guard reads for the shapes of `expressions`: each
/// one `value`d whole by `TABLE_SHAPE`, so read as `value` reads it (#2033).
export function shapeGuardCode(expressions: string[]): GuardCode {
  return expressions.map(valued);
}

export function readShape(raw: unknown, expression: string): Shape {
  const p = raw as unknown[];
  const bad = (): never => {
    throw new Error(`the process answered something other than a table's shape: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  if (!Array.isArray(p) || p.length !== 5 || typeof p[1] !== "string" || !["memory", "splayed", "partitioned"].includes(p[4] as string)) {
    return bad();
  }
  const types = p[1] as string;
  const one = types.length === 1;
  const strings = (v: unknown): string[] => (Array.isArray(v) && v.length === 0 ? [] : one && isString(v) ? [v] : (listOf(v, isString) ?? bad()));
  const columns = strings(p[0]);
  const attributes = strings(p[2]);
  const keys = Array.isArray(p[3]) && p[3].length === 0 ? [] : (listOf(p[3], isString) ?? bad());
  if (columns.length !== types.length || attributes.length !== types.length) {
    return bad();
  }
  return { expression, columns, types, attributes, keys, where: p[4] as Shape["where"] };
}

export interface Suggestion {
  join: "lj" | "ij" | "uj" | "aj" | "wj";
  expression: string;
  why: string;
}

/// Time-like types an `aj` or `wj` matches on.
const TEMPORAL = new Set(["p", "n", "t", "u", "v", "z", "d", "m"]);
/// Types a window of a second can be added to, and the second in each.
const SECOND: Record<string, string> = { p: "1000000000", n: "1000000000", t: "1000", u: "0", v: "1" };
const NUMERIC = new Set(["h", "i", "j", "e", "f"]);

/// `expression` without the comment it ends in: a `/` after a blank (or
/// at the start of its last line), outside a string. `value` reads past it,
/// so the shape is read, but in brackets it took the closing one (#3047).
function uncommented(expression: string): string {
  let quoted = false;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (quoted && c === "\\") {
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && c === "/" && (i === 0 || /\s/.test(expression[i - 1]))) {
      const end = expression.indexOf("\n", i);
      if (end < 0) {
        return expression.slice(0, i);
      }
      i = end;
    }
  }
  return expression;
}

/// An expression as an operand: a name as it is, anything else bracketed,
/// without the comment that ends it.
export function operand(expression: string): string {
  const e = uncommented(expression).trim();
  return /^\.?[A-Za-z][A-Za-z0-9_.]*$/.test(e) ? e : `(${e})`;
}

/// Column names as a symbol list: `` `a`b `` when each is bare, as
/// qliteral's symbolLiteral writes it; else `` (`$"trade id";`b) ``, in
/// parentheses even for one, so the `` `$ `` takes no more than its name (#1818).
const symbols = (names: string[]): string => {
  const each = names.map(symbolLiteral);
  return each.every((s) => !s.startsWith("`$")) ? each.join("") : `(${each.join(";")})`;
};

/// The joins `left` and `right` allow, the likeliest first.
export function suggestJoins(left: Shape, right: Shape): Suggestion[] {
  // q joins no partitioned table on the left - lj and ij signal 'splay, aj
  // 'date - so the left is one partition of it, the last, which the why
  // says to change to the one wanted (#2539).
  const field = left.where === "partitioned" ? left.columns[0] : undefined;
  const l = field === undefined ? operand(left.expression) : `(select from ${operand(left.expression)} where ${field}=last .Q.pv)`;
  const leftNote = field === undefined ? "" : ` ${left.expression.trim()} is partitioned, which q joins only one partition of at a time: this takes its last ${field}; change last .Q.pv to the ${field} wanted.`;
  const r = operand(right.expression);
  const type = (s: Shape, c: string) => s.types[s.columns.indexOf(c)] ?? " ";
  const attr = (s: Shape, c: string) => s.attributes[s.columns.indexOf(c)] ?? "";
  const common = left.columns.filter((c) => right.columns.includes(c));
  const out: Suggestion[] = [];
  const onDisk = (s: Shape): string =>
    (s.where === "partitioned" ? ` ${s.expression.trim()} is partitioned: select one date first (select from ${s.expression.trim()} where date=d), or every partition is read.` : "") + leftNote;

  // lj and ij: on the right table's keys, or on the columns it shares.
  if (right.keys.length > 0 && right.keys.every((k) => left.columns.includes(k))) {
    out.push({ join: "lj", expression: `${l} lj ${r}`, why: `Every row of ${left.expression.trim()}, with ${right.expression.trim()}'s columns where its keys ${right.keys.join(", ")} match; nulls where none does.${onDisk(right)}` });
    out.push({ join: "ij", expression: `${l} ij ${r}`, why: `Only the rows of ${left.expression.trim()} whose ${right.keys.join(", ")} ${right.keys.length === 1 ? "is" : "are"} in ${right.expression.trim()}.${onDisk(right)}` });
  } else if (right.keys.length === 0) {
    const keys = common.filter((c) => !TEMPORAL.has(type(right, c)) && !NUMERIC.has(type(right, c)) && type(right, c) !== "f");
    // A shared column left out of the keys would be overwritten in every
    // row by the right table's: only its own columns are joined (#2408).
    // With none of its own there is nothing to join, and q refuses a keyed
    // table of keys alone with 'type (#3048).
    const own = right.columns.filter((c) => !common.includes(c));
    if (keys.length > 0 && own.length > 0) {
      const dropped = common.filter((c) => !keys.includes(c));
      const keyed = `${symbols(keys)} xkey ${dropped.length > 0 ? `${symbols([...keys, ...own])}#${r}` : r}`;
      const kept = dropped.length > 0 ? ` Only its own columns, ${own.join(", ")}, are joined: a join on these keys would replace ${left.expression.trim()}'s ${dropped.join(", ")} with ${right.expression.trim()}'s.` : "";
      out.push({ join: "lj", expression: `${l} lj ${keyed}`, why: `${right.expression.trim()} has no keys, so it is keyed on the columns both share, ${keys.join(", ")}; where a key repeats, lj takes the first row with it.${kept}${onDisk(right)}` });
      out.push({ join: "ij", expression: `${l} ij ${keyed}`, why: `Only the rows of ${left.expression.trim()} with a match on ${keys.join(", ")}.${kept}${onDisk(right)}` });
    }
  }

  // aj and wj: on a time column both have, with the shared symbols before it.
  const time = common.find((c) => c === "time" && TEMPORAL.has(type(left, c)) && type(left, c) === type(right, c)) ?? common.find((c) => TEMPORAL.has(type(left, c)) && type(left, c) === type(right, c));
  if (time !== undefined) {
    const by = common.filter((c) => c !== time && type(left, c) === "s" && type(right, c) === "s");
    const cs = symbols([...by, time]);
    // aj finds the row by binary search: the right table in time order within
    // each symbol. A sorted, grouped or parted symbol column is taken as the
    // sign of a table kept so, but orders no time: the why says so (#1435).
    const byAttr = by.length === 0 ? "" : attr(right, by[0]);
    const ordered = right.where === "partitioned" || (by.length === 0 ? attr(right, time) === "s" : ["p", "g", "s"].includes(byAttr));
    const sorted = ordered ? r : `${cs} xasc ${r}`;
    const sortWhy = !ordered
      ? ` ${right.expression.trim()} is sorted by ${[...by, time].join(", ")} first: aj looks rows up by binary search, so it must be in time order${by.length > 0 ? ` within each ${by[0]}` : ""} (or have \`g# or \`p# on ${by[0] ?? "its key"}).`
      : right.where !== "partitioned" && by.length > 0
        ? ` \`${byAttr}# on ${by[0]} does not order ${time}: this takes ${right.expression.trim()} to be in ${time} order within each ${by[0]} already, as a tickerplant's table is; if it is not, use ${cs} xasc ${r}, or aj returns the wrong rows.`
        : "";
    out.push({
      join: "aj",
      expression: `aj[${cs};${l};${sorted}]`,
      why: `Each row of ${left.expression.trim()} with the last row of ${right.expression.trim()} at or before its ${time}${by.length > 0 ? `, for the same ${by.join(", ")}` : ""}.${sortWhy}${onDisk(right)}`,
    });
    const second = SECOND[type(left, time)];
    const value = right.columns.find((c) => !common.includes(c) && NUMERIC.has(type(right, c)));
    if (second !== undefined && second !== "0") {
      // Each name as symbolLiteral writes it - t`trade time indexes t by
      // `trade - and one not bare indexed in brackets: t[`$"trade time"] (#1845).
      // A keyed left table is unkeyed: indexed by a column's name it is
      // looked up by key, and wj refuses it ('type, #3046).
      const t = symbolLiteral(time);
      const wl = left.keys.length > 0 ? `(0!${l})` : l;
      const times = t.startsWith("`$") ? `${wl}[${t}]` : `${wl}${t}`;
      const aggregates = value === undefined ? `(${sorted};(count;${t}))` : `(${sorted};(max;${symbolLiteral(value)});(min;${symbolLiteral(value)}))`;
      const window = `wj[-${second} 0+\\:${times};${cs};${wl};${aggregates}]`;
      out.push({
        join: "wj",
        // The max and min would both be named for the column: renamed, so they can be told apart (#1573).
        expression: value === undefined ? window : `((cols ${wl}),${symbols([`${value}_max`, `${value}_min`])}) xcol ${window}`,
        why: `For each row of ${left.expression.trim()}, ${value === undefined ? "the count of" : `the max and min ${value} of`} the rows of ${right.expression.trim()} in the second up to its ${time}; change the window and the aggregates to suit.${left.keys.length > 0 ? ` wj takes no keyed table, so ${left.expression.trim()} is unkeyed (0!) and the answer has no key.` : ""}${sortWhy}${onDisk(right)}`,
      });
    }
  }

  // uj: tables alike, one under the other.
  const sameKeys = left.keys.join(" ") === right.keys.join(" ");
  if (sameKeys && common.length > 0 && common.length * 2 >= Math.max(left.columns.length, right.columns.length)) {
    // uj goes by name alone: a column of one type in each is mixed after,
    // which meta shows blank and sum and = read differently (#3049).
    const differ = common.filter((c) => type(left, c) !== type(right, c) && type(left, c) !== " " && type(right, c) !== " ");
    const mixed = differ.length === 0 ? "" : ` ${differ.map((c) => `${c} is ${type(left, c)} in ${left.expression.trim()} and ${type(right, c)} in ${right.expression.trim()}`).join(", ")}: uj makes ${differ.length === 1 ? "it a mixed column" : "each a mixed column"}, not one of either type; cast one side to the other's first.`;
    out.push({
      join: "uj",
      expression: `${l} uj ${r}`,
      why:
        left.keys.length > 0
          ? `Both keyed on ${left.keys.join(", ")}: one table, ${right.expression.trim()}'s rows replacing ${left.expression.trim()}'s where the keys match.${mixed}${leftNote}`
          : `The rows of both, ${right.expression.trim()}'s after ${left.expression.trim()}'s; a column only one has is null in the other's rows.${mixed}${leftNote}`,
    });
  }
  return out;
}

/// The last line `selection` has text on: whole lines selected end at
/// column 0 of the line after, which is not one of them (#1920).
export function lastSelectedLine(selection: { start: { line: number }; end: { line: number; character: number } }): number {
  const { start, end } = selection;
  return end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
}
