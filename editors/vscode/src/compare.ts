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
// (#1614), nor when a cell's text was cut at 200 characters.
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
  /// The columns both tables have whose type is not the same, with each
  /// side's: a float 1 and a long 1 are not the same answer.
  retyped: { column: string; left: string; right: string }[];
  /// Each table's key columns, where the two are not keyed by the same:
  /// a keyed table and an unkeyed one of the same cells are two values.
  rekeyed?: { left: string[]; right: string[] };
  /// Cells that are the same as far as their text goes, which was cut at
  /// 200 characters: the rest of each was not compared.
  cut: number;
  /// Whether the answers are text that holds a float only to the digits
  /// its process writes, so that `same` is the same to those digits.
  digits: boolean;
  /// Whether the two answers are the same.
  same: boolean;
  /// Whether either side came back cut - fewer rows than its result has,
  /// or console text cut - so only its first part was compared.
  partial: boolean;
}

/// Whether console text was cut at the console size: q ends it with `..`.
const textCut = (text: string): boolean => /\.\.$/.test(text.trimEnd());

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
/// sent, joined by a character no cell shows.
const keyOf = (side: Held, keys: number, row: number): string =>
  side.grid.cells
    .slice(0, keys)
    .map((c, i) => {
      const value = side.payload.types[i] === 0 ? undefined : side.raw[i]?.[row];
      return value === undefined || value === null ? c[row] : String(value);
    })
    .join("\u0000");

/// `left` and `right` lined up, floats to `decimals` places (`-1`: as the
/// process wrote them).
export function compareOutcomes(left: Outcome, right: Outcome, decimals: number): Comparison {
  const a = side(left);
  const b = side(right);
  const ha = "answer" in left && left.answer.ok && left.answer.grid !== undefined ? held(left.answer.grid, decimals) : undefined;
  const hb = "answer" in right && right.answer.ok && right.answer.grid !== undefined ? held(right.answer.grid, decimals) : undefined;
  if (ha === undefined || hb === undefined) {
    // Not two tables: the text each gave, a table as the console writes it.
    const text = (o: Outcome, s: Side): string => s.text ?? ("answer" in o && o.answer.ok ? o.answer.text.join("\n") : "");
    const sa = { ...a.side, text: text(left, a.side) };
    const sb = { ...b.side, text: text(right, b.side) };
    const partial = (sa.kind === "text" && textCut(sa.text)) || (sb.kind === "text" && textCut(sb.text));
    const same = !partial && sa.kind === sb.kind && sa.text === sb.text;
    // Two values' text, not two errors': the same to the digits written,
    // unless the text of their type is the whole value.
    const digits = same && sa.kind === "text" && [left, right].some((o) => "answer" in o && o.answer.ok && !exactText(o.answer.type));
    return { left: sa, right: sb, columns: [], inLeft: [], inRight: [], matchedBy: "place", rows: [], lined: 0, differing: 0, onlyLeft: 0, onlyRight: 0, retyped: [], cut: 0, digits, same, partial };
  }
  const ga = ha.grid;
  const gb = hb.grid;
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
  let cut = 0;
  const rows: ComparedRow[] = [];
  for (const [ra, rb] of pairs) {
    const l = cells(ga, indexA, ra);
    const r = cells(gb, indexB, rb);
    const differs = columns.map((_, i) => ra === undefined || rb === undefined || indexA[i] < 0 || indexB[i] < 0 || cellDiffers(i, ra, rb));
    if (l === undefined || ra === undefined) {
      onlyRight++;
    } else if (r === undefined || rb === undefined) {
      onlyLeft++;
    } else {
      differing += differs.filter(Boolean).length;
      columns.forEach((_, i) => {
        if (indexA[i] < 0 || indexB[i] < 0) {
          return;
        }
        if (differs[i] && l[i] === r[i]) {
          // The difference is past what the grid shows: each in full.
          l[i] = atomLiteral(ha.payload.types[indexA[i]], ...sent(ha, indexA[i], ra)).literal;
          r[i] = atomLiteral(hb.payload.types[indexB[i]], ...sent(hb, indexB[i], rb)).literal;
        } else if (!differs[i] && ha.payload.types[indexA[i]] === 0 && l[i].endsWith("..")) {
          cut++;
        }
      });
    }
    if (rows.length < COMPARE_ROWS) {
      rows.push({ ...(l !== undefined ? { left: l } : {}), ...(r !== undefined ? { right: r } : {}), differs });
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
    retyped,
    ...(keyedAlike ? {} : { rekeyed: { left: namesA.slice(0, keysA), right: namesB.slice(0, keysB) } }),
    cut,
    digits: false,
    same: !partial && sameColumns && keyedAlike && retyped.length === 0 && cut === 0 && differing === 0 && onlyLeft === 0 && onlyRight === 0 && ga.total === gb.total,
    partial,
  };
}
