// What changed between two runs of the same query: the result panel's
// Compare with Previous Run.
//
// Rows are matched by their key when both results are keyed by the same
// columns - a keyed table, a dictionary - and otherwise by their place.
// Columns are matched by name. A cell is compared by the text the grid shows
// for it, so a float compares to the decimals `q-lint.query.gridDecimals`
// asks for, and a timestamp to its nanosecond. Only the rows each grid holds
// are compared: a result cut at `q-lint.query.gridLimit` is compared as far
// as it was sent, and a row the other side's cut may have left out is
// neither added nor removed, only counted as not compared (#1640).
import { rowCount, type Grid } from "./grid";

/// The most changed cells, and removed rows, a diff lists: the rest are
/// counted.
export const DIFF_CELLS = 50000;
export const DIFF_REMOVED_ROWS = 100;

export interface GridDiff {
  /// "key" when rows were matched by their key columns, "place" when by
  /// their row number.
  matchedBy: "key" | "place";
  /// Changed cells of the result on show: [column, row, the previous text].
  changes: [number, number, string][];
  /// Every changed cell, of which `changes` lists the first DIFF_CELLS.
  changed: number;
  /// Rows of the result on show that the previous one did not have.
  addedRows: number[];
  /// Columns of the result on show that the previous one did not have.
  addedColumns: number[];
  /// Columns the previous result had that this one has not.
  removedColumns: string[];
  /// Rows the previous result had that this one has not: its columns, and
  /// the first DIFF_REMOVED_ROWS rows as their cells showed them.
  removed: { columns: string[]; rows: string[][]; count: number };
  /// Rows of either result with no match in the other, which was cut, so
  /// may have held it past its cut: not called added or removed.
  uncompared: number;
}

/// A row's key: the text of its key columns, joined by a character no cell
/// shows.
function keyOf(grid: Grid, keys: number, row: number): string {
  let key = "";
  for (let c = 0; c < keys; c++) {
    key += `${grid.cells[c][row]}\u0000`;
  }
  return key;
}

/// How many leading key columns `grid` has.
const keyCount = (grid: Grid): number => grid.columns.filter((c) => c.key).length;

/// What changed from `before` to `after`, as the grid of `after` shows it.
export function diffGrids(before: Grid, after: Grid): GridDiff {
  const keys = keyCount(after);
  const byKey =
    keys > 0 && keys === keyCount(before) && after.columns.slice(0, keys).every((c, i) => c.name === before.columns[i].name);
  const was = rowCount(before);
  const now = rowCount(after);
  // Either was cut: a row with no match may be past the cut.
  const wasCut = before.total > was;
  const nowCut = after.total > now;
  let uncompared = 0;
  // The previous row each row of `after` matches, or -1. Two rows with one
  // key (a dictionary can have them) are matched in their order.
  const match = new Array<number>(now).fill(-1);
  const used = new Array<boolean>(was).fill(false);
  if (byKey) {
    const rows = new Map<string, number[]>();
    for (let r = 0; r < was; r++) {
      const k = keyOf(before, keys, r);
      const list = rows.get(k);
      if (list === undefined) {
        rows.set(k, [r]);
      } else {
        list.push(r);
      }
    }
    // How far into each key's list rows are taken: shift() would copy the
    // list down each time, quadratic in a key's rows (#1860).
    const taken = new Map<string, number>();
    for (let r = 0; r < now; r++) {
      const k = keyOf(after, keys, r);
      const list = rows.get(k);
      const next = taken.get(k) ?? 0;
      const b = list?.[next];
      if (b !== undefined) {
        taken.set(k, next + 1);
        match[r] = b;
        used[b] = true;
      }
    }
  } else {
    for (let r = 0; r < Math.min(was, now); r++) {
      match[r] = r;
      used[r] = true;
    }
  }
  // A column's place in `before`, by name: the first of that name.
  const names = new Map<string, number>();
  before.columns.forEach((c, i) => {
    if (!names.has(c.name)) {
      names.set(c.name, i);
    }
  });
  const columnIn = after.columns.map((c) => names.get(c.name) ?? -1);
  const kept = new Set(columnIn.filter((i) => i >= 0));
  const changes: [number, number, string][] = [];
  let changed = 0;
  columnIn.forEach((b, c) => {
    if (b < 0) {
      return;
    }
    const old = before.cells[b];
    const cur = after.cells[c];
    for (let r = 0; r < now; r++) {
      const m = match[r];
      if (m >= 0 && old[m] !== cur[r]) {
        changed++;
        if (changes.length < DIFF_CELLS) {
          changes.push([c, r, old[m]]);
        }
      }
    }
  });
  const gone: string[][] = [];
  let count = 0;
  for (let r = 0; r < was; r++) {
    if (!used[r] && nowCut) {
      uncompared++;
    } else if (!used[r]) {
      count++;
      if (gone.length < DIFF_REMOVED_ROWS) {
        gone.push(before.cells.map((column) => column[r]));
      }
    }
  }
  const addedRows = match.flatMap((m, r) => (m < 0 && !wasCut ? [r] : []));
  uncompared += wasCut ? match.filter((m) => m < 0).length : 0;
  return {
    matchedBy: byKey ? "key" : "place",
    changes,
    changed,
    addedRows,
    addedColumns: columnIn.flatMap((b, c) => (b < 0 ? [c] : [])),
    removedColumns: before.columns.filter((_, i) => !kept.has(i)).map((c) => c.name),
    removed: { columns: before.columns.map((c) => c.name), rows: gone, count },
    uncompared,
  };
}
