// Compare Query (#907), as data: two processes' answers to one query, lined
// up row by row with the cells that differ marked. No `vscode` import, so
// node tests it; `compareview.ts` draws it, and `queryacross.ts` runs it.
//
// Two tables are lined up as Compare with Previous Run lines up two runs
// (`resultdiff.ts`): by their key when both are keyed by the same columns,
// and otherwise by their place. Columns are matched by name, the first
// table's order first. A cell is compared by its value where `GRID` sent
// one - a number, a temporal, a char, the floats in a general list's item -
// and by q's text of it where that is the whole value; the text the grid
// shows, floats to `q-lint.query.gridDecimals`, is only what is drawn, and
// two columns of one name are the same only if their types are (#1963),
// and two tables only if they are keyed by the same columns (#2008).
// Anything else - a value that is not tabular, an error, a process not
// reached - is compared as the text each side gave, which holds a float
// only to its process's `\P`: `digits` says so. Only what came back is
// compared: when a side held fewer rows than its result has, or its text
// was cut at the console size, the answers are never called the same
// (#1614), nor when a cell's text was cut at 200 characters. A cut is told
// by the length it leaves a text, not by the `..` it ends in, which a
// symbol or a path may end in itself (#2010).
import { toGrid, typeName, type Grid, type GridPayload } from "./grid";
import { atomLiteral, rawColumn } from "./qliteral";
import type { Outcome } from "./tagquery";

export const COMPARE = {
  command: "q-lint.compareQuery",
} as const;

export interface CompareSettings {
  enabled: boolean;
}

/// The settings read as `readLive` reads the query ones, at each use.
export function readCompare(get: <T>(key: string, fallback: T) => T): CompareSettings {
  return { enabled: get<unknown>("query.compare.enable", true) !== false };
}

/// The most lined-up rows drawn; the rest are counted.
export const COMPARE_ROWS = 5000;

export interface Side {
  process: string;
  /// "grid" for a table, "text" for any other value, "error" for none.
  kind: "grid" | "text" | "error";
  /// The text of a value that is not tabular, or the error.
  text?: string;
  /// The rows the whole result had, for a table.
  total?: number;
}

export interface ComparedRow {
  /// Each column's cell on either side; undefined where that side has no
  /// such row.
  left?: string[];
  right?: string[];
  /// Whether each column's cells differ.
  differs: boolean[];
  /// A row one side has and the other may: it came back cut (#2158).
  uncompared?: boolean;
}

export interface Comparison {
  left: Side;
  right: Side;
  /// Both tables' columns, the first's order first; empty unless both are tables.
  columns: string[];
  /// Whether each column is in the first table, and in the second.
  inLeft: boolean[];
  inRight: boolean[];
  matchedBy: "key" | "place";
  /// The first `COMPARE_ROWS` rows lined up.
  rows: ComparedRow[];
  /// Every row lined up, of which `rows` holds the first COMPARE_ROWS.
  lined: number;
  /// Cells that differ in rows both sides have, and rows only one side has.
  differing: number;
  onlyLeft: number;
  onlyRight: number;
  /// Rows one side has that the other, cut, may have past what it sent:
  /// neither only on one side nor compared (#2158).
  uncompared: number;
  /// The columns both tables have whose type is not the same, with each
  /// side's: a float 1 and a long 1 are not the same answer.
  retyped: { column: string; left: string; right: string }[];
  /// Each table's key columns, where the two are not keyed by the same:
  /// a keyed table and an unkeyed one of the same cells are two values.
  rekeyed?: { left: string[]; right: string[] };
  /// What each answer is, where the two are not alike: `GRID` makes a list
  /// a table of one column and a dictionary a keyed table, which are other
  /// values to q (#2163).
  reshaped?: { left: string; right: string };
  /// Cells that are the same as far as their text goes, which was cut at
  /// 200 characters: the rest of each was not compared.
  cut: number;
  /// Of those, the cells `GRID` did not cut at 200 characters, which end in
  /// `..` as `-3!` leaves an item it cut at the process's `\c` (#2165).
  consoleCut: number;
  /// Whether the answers are text that holds a float only to the digits
  /// its process writes, so that `same` is the same to those digits.
  digits: boolean;
  /// Answers whose text differs only in how many digits of a float each
  /// wrote, and agrees to the fewer: written at two `\P`s, they may be the
  /// same value or not (#2159). For two tables, the cells so compared.
  toDigits: number;
  /// Whether the two answers are the same.
  same: boolean;
  /// Whether either side came back cut - fewer rows than its result has,
  /// or console text cut - so only its first part was compared.
  partial: boolean;
  /// Whether the text that made it `partial` may as well be whole: it ends
  /// in `..` as a cut at the process's unknown `\c` would leave it (#2164).
  unsureCut?: boolean;
}

/// The fewest characters `-3!` leaves of a text it cuts: it stops one short
/// of the process's `\c` width, which q keeps at 10 or more.
const LEAST_CUT = 9;

/// Whether `-3!` text may have been cut, at the process's `\c` or by `GRID`
/// at 200 characters: it ends `..` and is as long as a cut leaves. The
/// process's `\c` is not sent, so a longer text that only ends so counts.
const itemCut = (text: string): boolean => text.endsWith("..") && text.length >= LEAST_CUT;

/// Whether the console text of a value of `type` may have been cut. `.Q.S`
/// cuts a line at the console's `width`, leaving that many characters (at
/// a width of 1, three; one fewer where an unwrapped run cut inside a
/// character), and rows past its height are one last line of `..`. Every
/// value but a function (100 on) is `-3!` text first. With no `width`
/// given, any line ending `..` may be one the console cut. "maybe" where
/// only a cut at the process's `\c`, which is not sent, would leave it so:
/// whether it is one cannot be told (#2164).
function textCut(lines: string[], type: number, width: number | undefined): "sure" | "maybe" | undefined {
  const sure = (line: string, i: number): boolean =>
    width !== undefined && ((line.length >= width - 1 && line.length <= Math.max(width, 3)) || (line === ".." && i === lines.length - 1));
  const ends = lines.map((line) => line.endsWith(".."));
  if (lines.some((line, i) => ends[i] && sure(line, i))) {
    return "sure";
  }
  return lines.some((line, i) => ends[i] && (width === undefined || (type < 100 && itemCut(line)))) ? "maybe" : undefined;
}

/// What a value of `type` that `GRID` made a table of is: a dictionary and
/// a keyed table are both 99, and only the console tells them apart - a
/// keyed table's first line names its columns, its second is dashes.
function shape(type: number, text: string[]): string {
  if (type === 99) {
    return text.length > 1 && /^\S.*\|/.test(text[0]) && /^-+\|/.test(text[1]) ? "a keyed table" : "a dictionary";
  }
  return type === 98 ? "a table" : "a list";
}

function side(outcome: Outcome): { side: Side } {
  if ("error" in outcome) {
    return { side: { process: outcome.process, kind: "error", text: outcome.error } };
  }
  const { answer } = outcome;
  if (!answer.ok) {
    return { side: { process: outcome.process, kind: "error", text: `'${answer.error}` } };
  }
  if (answer.grid === undefined) {
    return { side: { process: outcome.process, kind: "text", text: answer.text.join("\n") } };
  }
  return { side: { process: outcome.process, kind: "grid", total: answer.grid.count } };
}

/// The types whose console text is the whole value: every atom but a
/// float, a real and a datetime, a string, and a function.
const exactText = (type: number): boolean => type === 10 || type >= 100 || (type < 0 && ![-8, -9, -15].includes(type));

/// A float in q's text: not inside a name, a date or a time, and with no
/// more than a float's `f` or a real's `e` after it.
const NUMBER = /(?<![\w`".:-])-?\d+(?:\.\d*)?(?:e[+-]?\d+)?(?=[fe]?(?![\w.:]))/g;

/// Whether texts `a` and `b`, which differ, differ only in the digits of
/// their numbers, each of which may be the other's written to more or
/// fewer digits: what each number's text says of its value - within half
/// its last digit - overlaps the other's (#2159).
export function sameToDigits(a: string, b: string): boolean {
  const na = [...a.matchAll(NUMBER)];
  const nb = [...b.matchAll(NUMBER)];
  if (a === b || na.length === 0 || na.length !== nb.length || a.replace(NUMBER, "#") !== b.replace(NUMBER, "#")) {
    return false;
  }
  // Half a unit of the last digit written: 0.333 is 0.333 +- 0.0005.
  const half = (t: string): number => {
    const [m, e] = t.replace("-", "").split("e");
    const point = m.indexOf(".");
    return 0.5 * 10 ** (Number(e ?? 0) - (point < 0 ? 0 : m.length - point - 1));
  };
  return na.every((x, i) => Math.abs(Number(x[0]) - Number(nb[i][0])) < half(x[0]) + half(nb[i][0]));
}

/// Whether two values `GRID` sent are the same: a long by its digits,
/// however it was decoded, and a general list's item part by part.
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  return a === null || b === null ? a === b : String(a) === String(b);
}

/// One side's table: what the grid shows of it, and what `GRID` sent.
interface Held {
  grid: Grid;
  payload: GridPayload;
  raw: (unknown[] | undefined)[];
}

const held = (payload: GridPayload, decimals: number): Held => ({ grid: toGrid(payload, decimals), payload, raw: payload.names.map((_, i) => rawColumn(payload, i)) });

/// A row's key: its key columns' values, or their text where none was
/// sent, joined by a character no cell shows. A symbol's raw is its bytes
/// when one is past ASCII and `false` when none is, so it keys by those
/// bytes or by its text, never by `"false"` (#2460).
const keyOf = (side: Held, keys: number, row: number): string =>
  side.grid.cells
    .slice(0, keys)
    .map((c, i) => {
      const value = side.payload.types[i] === 0 ? undefined : side.raw[i]?.[row];
      if (side.payload.types[i] === 11) {
        return Array.isArray(value) ? `\u0001${value.join(",")}` : c[row];
      }
      return value === undefined || value === null ? c[row] : String(value);
    })
    .join("\u0000");

/// `left` and `right` lined up, floats to `decimals` places (`-1`: as the
/// process wrote them). `width` is the console width their text was asked
/// for, where it is known.
export function compareOutcomes(left: Outcome, right: Outcome, decimals: number, width?: number): Comparison {
  const a = side(left);
  const b = side(right);
  const ha = "answer" in left && left.answer.ok && left.answer.grid !== undefined ? held(left.answer.grid, decimals) : undefined;
  const hb = "answer" in right && right.answer.ok && right.answer.grid !== undefined ? held(right.answer.grid, decimals) : undefined;
  if (ha === undefined || hb === undefined) {
    // Not two tables: the text each gave, a table as the console writes it.
    const text = (o: Outcome, s: Side): string => s.text ?? ("answer" in o && o.answer.ok ? o.answer.text.join("\n") : "");
    const sa = { ...a.side, text: text(left, a.side) };
    const sb = { ...b.side, text: text(right, b.side) };
    const cut = (o: Outcome, s: Side): "sure" | "maybe" | undefined => (s.kind === "text" && "answer" in o && o.answer.ok ? textCut(o.answer.text, o.answer.type, width) : undefined);
    const cuts = [cut(left, sa), cut(right, sb)];
    const partial = cuts.some((c) => c !== undefined);
    const unsureCut = partial && !cuts.includes("sure");
    // And of one type, an enumeration's number aside (#2163).
    const typed = (o: Outcome): string => ("answer" in o && o.answer.ok ? typeName(o.answer.type) : "");
    const same = !partial && sa.kind === sb.kind && sa.text === sb.text && typed(left) === typed(right);
    // Two values' text, not two errors': the same to the digits written,
    // unless the text of their type is the whole value.
    const digits = same && sa.kind === "text" && [left, right].some((o) => "answer" in o && o.answer.ok && !exactText(o.answer.type));
    // Of one type, and not one whose text is all of it, to fewer digits on one.
    const typeOf = (o: Outcome): number | undefined => ("answer" in o && o.answer.ok ? o.answer.type : undefined);
    const toDigits =
      !same && !partial && sa.kind === "text" && sb.kind === "text" && typeOf(left) === typeOf(right) && !exactText(typeOf(left) ?? 10) && sameToDigits(sa.text, sb.text) ? 1 : 0;
    return { left: sa, right: sb, columns: [], inLeft: [], inRight: [], matchedBy: "place", rows: [], lined: 0, differing: 0, onlyLeft: 0, onlyRight: 0, uncompared: 0, retyped: [], cut: 0, consoleCut: 0, digits, toDigits, same, partial, unsureCut };
  }
  const ga = ha.grid;
  const gb = hb.grid;
  const shapes = [left, right].map((o) => ("answer" in o && o.answer.ok ? shape(o.answer.type, o.answer.text) : ""));
  const namesA = ga.columns.map((c) => c.name);
  const namesB = gb.columns.map((c) => c.name);
  // A name a table repeats, as a join can, is matched occurrence by
  // occurrence: the second `a` with the other side's second (#1964).
  const nth = (names: string[]): string[] => {
    const seen = new Map<string, number>();
    return names.map((n) => {
      const k = seen.get(n) ?? 0;
      seen.set(n, k + 1);
      return `${k}\u0000${n}`;
    });
  };
  const idsA = nth(namesA);
  const idsB = nth(namesB);
  const ids = [...idsA, ...idsB.filter((n) => !idsA.includes(n))];
  const columns = ids.map((id) => id.slice(id.indexOf("\u0000") + 1));
  const indexA = ids.map((id) => idsA.indexOf(id));
  const indexB = ids.map((id) => idsB.indexOf(id));
  const keysA = ga.columns.filter((c) => c.key).length;
  const keysB = gb.columns.filter((c) => c.key).length;
  const keyedAlike = keysA === keysB && namesA.slice(0, keysA).join("\u0000") === namesB.slice(0, keysB).join("\u0000");
  const byKey = keysA > 0 && keyedAlike;
  const countA = ga.cells[0]?.length ?? 0;
  const countB = gb.cells[0]?.length ?? 0;
  // Pairs of row numbers, either side undefined where it has no such row.
  const pairs: [number | undefined, number | undefined][] = [];
  if (byKey) {
    const waiting = new Map<string, number[]>();
    for (let r = 0; r < countB; r++) {
      const k = keyOf(hb, keysB, r);
      const list = waiting.get(k);
      if (list === undefined) {
        waiting.set(k, [r]);
      } else {
        list.push(r);
      }
    }
    // How far into each key's list rows are taken, not shift(), which is
    // quadratic in a key's rows (#1860).
    const taken = new Map<string, number>();
    const used = new Set<number>();
    for (let r = 0; r < countA; r++) {
      const k = keyOf(ha, keysA, r);
      const next = taken.get(k) ?? 0;
      const match = waiting.get(k)?.[next];
      if (match !== undefined) {
        taken.set(k, next + 1);
        used.add(match);
      }
      pairs.push([r, match]);
    }
    for (let r = 0; r < countB; r++) {
      if (!used.has(r)) {
        pairs.push([undefined, r]);
      }
    }
  } else {
    for (let r = 0; r < Math.max(countA, countB); r++) {
      pairs.push([r < countA ? r : undefined, r < countB ? r : undefined]);
    }
  }
  const cells = (grid: Grid, index: number[], row: number | undefined): string[] | undefined =>
    row === undefined ? undefined : index.map((i) => (i < 0 ? "" : (grid.cells[i][row] ?? "")));
  // Each column's type on either side, by its name: an enumeration's
  // number is its process's own.
  const typeA = indexA.map((i) => (i < 0 ? "" : typeName(ha.payload.types[i])));
  const typeB = indexB.map((i) => (i < 0 ? "" : typeName(hb.payload.types[i])));
  const retyped = columns.flatMap((column, i) => (indexA[i] >= 0 && indexB[i] >= 0 && typeA[i] !== typeB[i] ? [{ column, left: typeA[i], right: typeB[i] }] : []));
  // q's text of a cell and the value sent for it, if one was.
  const sent = (side: Held, i: number, row: number): [string, unknown] => [side.payload.cells[i][row] ?? "", side.raw[i]?.[row]];
  // Whether a cell both sides have differs: by its value where both sent
  // one - `false` is a general list's item whose text is all of it - and
  // by q's text otherwise. Two types of one text and number, a minute and
  // a second, are two values.
  const cellDiffers = (i: number, ra: number, rb: number): boolean => {
    const [ta, va] = sent(ha, indexA[i], ra);
    const [tb, vb] = sent(hb, indexB[i], rb);
    if (va === undefined || vb === undefined) {
      return ta !== tb;
    }
    return !sameValue(va, vb) || ((va === false || typeA[i] !== typeB[i]) && ta !== tb);
  };
  let differing = 0;
  let onlyLeft = 0;
  let onlyRight = 0;
  let uncompared = 0;
  let cut = 0;
  let consoleCut = 0;
  let toDigits = 0;
  // A cell compared by its text, of a type that may hold a float - a
  // general list's, a table's or a dictionary's - written to two `\P`s.
  const digitsApart = (i: number, ra: number, rb: number): boolean => {
    const [ta, va] = sent(ha, indexA[i], ra);
    const [tb, vb] = sent(hb, indexB[i], rb);
    const type = ha.payload.types[indexA[i]];
    return (va === undefined || vb === undefined) && type === hb.payload.types[indexB[i]] && (type === 0 || type >= 77) && sameToDigits(ta, tb);
  };
  // A side that sent fewer rows than it has may hold a row the other has
  // past them, by its key or its place: that row is not compared (#2158).
  const cutA = countA < ga.total;
  const cutB = countB < gb.total;
  const rows: ComparedRow[] = [];
  for (const [ra, rb] of pairs) {
    const l = cells(ga, indexA, ra);
    const r = cells(gb, indexB, rb);
    const differs = columns.map((_, i) => ra === undefined || rb === undefined || indexA[i] < 0 || indexB[i] < 0 || cellDiffers(i, ra, rb));
    const unknown = (l === undefined && cutA) || (r === undefined && cutB);
    if (unknown) {
      uncompared++;
    } else if (l === undefined || ra === undefined) {
      onlyRight++;
    } else if (r === undefined || rb === undefined) {
      onlyLeft++;
    } else {
      columns.forEach((_, i) => {
        if (differs[i] && indexA[i] >= 0 && indexB[i] >= 0 && digitsApart(i, ra, rb)) {
          differs[i] = false;
          toDigits++;
        }
      });
      differing += differs.filter(Boolean).length;
      columns.forEach((_, i) => {
        if (indexA[i] < 0 || indexB[i] < 0) {
          return;
        }
        if (differs[i] && l[i] === r[i]) {
          // The difference is past what the grid shows: each in full.
          l[i] = atomLiteral(ha.payload.types[indexA[i]], ...sent(ha, indexA[i], ra)).literal;
          r[i] = atomLiteral(hb.payload.types[indexB[i]], ...sent(hb, indexB[i], rb)).literal;
        } else if (!differs[i] && ha.payload.types[indexA[i]] === 0 && itemCut(sent(ha, indexA[i], ra)[0])) {
          cut++;
          // GRID's cut leaves 200 bytes ending `...`; any other, `-3!`'s.
          const text = sent(ha, indexA[i], ra)[0];
          consoleCut += text.endsWith("...") && Buffer.byteLength(text, "utf8") === 200 ? 0 : 1;
        }
      });
    }
    if (rows.length < COMPARE_ROWS) {
      rows.push({ ...(l !== undefined ? { left: l } : {}), ...(r !== undefined ? { right: r } : {}), differs, ...(unknown ? { uncompared: true } : {}) });
    }
  }
  const sameColumns = namesA.length === namesB.length && namesA.every((n, i) => n === namesB[i]);
  const partial = countA < ga.total || countB < gb.total;
  return {
    left: a.side,
    right: b.side,
    columns,
    inLeft: indexA.map((i) => i >= 0),
    inRight: indexB.map((i) => i >= 0),
    matchedBy: byKey ? "key" : "place",
    rows,
    lined: pairs.length,
    differing,
    onlyLeft,
    onlyRight,
    uncompared,
    retyped,
    ...(shapes[0] === shapes[1] ? {} : { reshaped: { left: shapes[0], right: shapes[1] } }),
    ...(keyedAlike ? {} : { rekeyed: { left: namesA.slice(0, keysA), right: namesB.slice(0, keysB) } }),
    cut,
    consoleCut,
    digits: false,
    toDigits,
    same: !partial && sameColumns && keyedAlike && shapes[0] === shapes[1] && retyped.length === 0 && cut === 0 && toDigits === 0 && differing === 0 && onlyLeft === 0 && onlyRight === 0 && ga.total === gb.total,
    partial,
  };
}
