// Compare Query (#907), as data: two processes' answers to one query, lined
// up row by row with the cells that differ marked. No `vscode` import, so
// node tests it; `compareview.ts` draws it, and `queryacross.ts` runs it.
//
// Two tables are lined up as Compare with Previous Run lines up two runs
// (`resultdiff.ts`): by their key when both are keyed by the same columns,
// and otherwise by their place. Columns are matched by name, the first
// table's order first. A cell is compared by the text the grid shows, so a
// float compares to `q-lint.query.gridDecimals`. Anything else - a value
// that is not tabular, an error, a process not reached - is compared as
// the text each side gave.
import { toGrid, type Grid } from "./grid";
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
  /// Whether the two answers are the same.
  same: boolean;
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

/// A row's key: its key columns' text, joined by a character no cell shows.
const keyOf = (grid: Grid, keys: number, row: number): string => grid.cells.slice(0, keys).map((c) => c[row]).join("\u0000");

/// `left` and `right` lined up, floats to `decimals` places (`-1`: as the
/// process wrote them).
export function compareOutcomes(left: Outcome, right: Outcome, decimals: number): Comparison {
  const a = side(left);
  const b = side(right);
  const ga = "answer" in left && left.answer.ok && left.answer.grid !== undefined ? toGrid(left.answer.grid, decimals) : undefined;
  const gb = "answer" in right && right.answer.ok && right.answer.grid !== undefined ? toGrid(right.answer.grid, decimals) : undefined;
  if (ga === undefined || gb === undefined) {
    // Not two tables: the text each gave, a table as the console writes it.
    const text = (o: Outcome, s: Side): string => s.text ?? ("answer" in o && o.answer.ok ? o.answer.text.join("\n") : "");
    const sa = { ...a.side, text: text(left, a.side) };
    const sb = { ...b.side, text: text(right, b.side) };
    return { left: sa, right: sb, columns: [], inLeft: [], inRight: [], matchedBy: "place", rows: [], lined: 0, differing: 0, onlyLeft: 0, onlyRight: 0, same: sa.kind === sb.kind && sa.text === sb.text };
  }
  const namesA = ga.columns.map((c) => c.name);
  const namesB = gb.columns.map((c) => c.name);
  const columns = [...namesA, ...namesB.filter((n) => !namesA.includes(n))];
  const indexA = columns.map((n) => namesA.indexOf(n));
  const indexB = columns.map((n) => namesB.indexOf(n));
  const keysA = ga.columns.filter((c) => c.key).length;
  const keysB = gb.columns.filter((c) => c.key).length;
  const byKey = keysA > 0 && keysA === keysB && namesA.slice(0, keysA).join("\u0000") === namesB.slice(0, keysB).join("\u0000");
  const countA = ga.cells[0]?.length ?? 0;
  const countB = gb.cells[0]?.length ?? 0;
  // Pairs of row numbers, either side undefined where it has no such row.
  const pairs: [number | undefined, number | undefined][] = [];
  if (byKey) {
    const waiting = new Map<string, number[]>();
    for (let r = 0; r < countB; r++) {
      const k = keyOf(gb, keysB, r);
      waiting.set(k, [...(waiting.get(k) ?? []), r]);
    }
    const used = new Set<number>();
    for (let r = 0; r < countA; r++) {
      const match = waiting.get(keyOf(ga, keysA, r))?.shift();
      if (match !== undefined) {
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
  let differing = 0;
  let onlyLeft = 0;
  let onlyRight = 0;
  const rows: ComparedRow[] = [];
  for (const [ra, rb] of pairs) {
    const l = cells(ga, indexA, ra);
    const r = cells(gb, indexB, rb);
    const differs = columns.map((_, i) => l === undefined || r === undefined || indexA[i] < 0 || indexB[i] < 0 || l[i] !== r[i]);
    if (l === undefined) {
      onlyRight++;
    } else if (r === undefined) {
      onlyLeft++;
    } else {
      differing += differs.filter(Boolean).length;
    }
    if (rows.length < COMPARE_ROWS) {
      rows.push({ ...(l !== undefined ? { left: l } : {}), ...(r !== undefined ? { right: r } : {}), differs });
    }
  }
  const sameColumns = namesA.length === namesB.length && namesA.every((n, i) => n === namesB[i]);
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
    same: sameColumns && differing === 0 && onlyLeft === 0 && onlyRight === 0 && ga.total === gb.total,
  };
}
