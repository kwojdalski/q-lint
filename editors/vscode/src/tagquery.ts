// Query a Tag (#906), as data: which processes carry a tag, and how their
// answers become one table with a leading `process` column. No `vscode`
// import, so node tests it; `queryacross.ts` is the VS Code around it.
//
// Each process's answer is its `GRID` payload (`grid.ts`), cut at
// `q-lint.query.gridLimit` as a grid-mode query is. A table's rows are kept
// as they came, under the union of every table's columns, in the order
// first seen; a column one process lacks is empty in its rows. A value
// that is not tabular is one row, its text in a `result` column; an error,
// or a process that could not be reached, one row with its message in an
// `error` column. A column whose type differs between processes is a
// general list, shown as each process wrote it. The ranks the panel sorts
// by are worked out again here over all the rows: each process's own say
// nothing of another's.
import { qualified, type Discovered } from "./discovery";
import { denseRank, sortText, type GridAnswer, type GridPayload } from "./grid";
import type { Process } from "./processes";

export const TAG_QUERY = {
  command: "q-lint.queryTag",
} as const;

export interface TagQuerySettings {
  enabled: boolean;
}

/// The settings read as `readLive` reads the query ones, at each use.
export function readTagQuery(get: <T>(key: string, fallback: T) => T): TagQuerySettings {
  return { enabled: get<unknown>("query.tagQuery.enable", true) !== false };
}

/// The most processes queried at once.
export const AT_ONCE = 8;

/// Every saved and discovered process tagged `tag`, ignoring case; a
/// discovered one's label qualified, as Connect names it.
export function tagged(saved: Process[], discovered: Discovered[], tag: string): Process[] {
  const want = tag.trim().toLowerCase();
  const has = (p: Process): boolean => p.tags.some((t) => t.trim().toLowerCase() === want);
  return [
    ...saved.filter(has),
    ...discovered.flatMap(({ server, state }) =>
      state.processes.filter(has).map((p) => ({ ...p, label: qualified(server.label, p.label), server: server.label })),
    ),
  ];
}

/// Every tag a saved or discovered process carries, with how many do,
/// sorted by name; a tag written in two cases is one, as first written.
export function allTags(saved: Process[], discovered: Discovered[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const p of [...saved, ...discovered.flatMap(({ state }) => state.processes)]) {
    for (const tag of new Set(p.tags.map((t) => t.trim()).filter((t) => t !== ""))) {
      const key = tag.toLowerCase();
      const seen = counts.get(key) ?? { tag, count: 0 };
      seen.count++;
      counts.set(key, seen);
    }
  }
  return [...counts.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

/// One process's outcome: its answer, or why there is none.
export type Outcome = { process: string; answer: GridAnswer } | { process: string; error: string };

/// The types whose raw values are numbers the rows can be ordered by.
const ORDERED = new Set([5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19]);

/// Each value's place among the column's distinct values, ascending, equal
/// values sharing one: by number where every value has one (null first,
/// then -0W to 0W, as q sorts), else by text, a string item by its
/// characters.
function ranks(type: number, cells: string[], raw: unknown[]): number[] {
  const numeric = ORDERED.has(type) && raw.length === cells.length;
  const key = (x: unknown): number => (x === null || x === undefined ? -Infinity : x === -Infinity ? -Number.MAX_VALUE : x === Infinity ? Number.MAX_VALUE : Number(x));
  const keys: (number | string)[] = numeric ? raw.map(key) : cells.map(sortText);
  return denseRank(cells.length, (a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
}

/// The answers of every process as one payload, a `process` column first.
export function mergeOutcomes(outcomes: Outcome[]): GridPayload {
  const names: string[] = [];
  const types = new Map<string, number>();
  let results = false;
  let errors = false;
  for (const o of outcomes) {
    if ("error" in o || !o.answer.ok) {
      errors = true;
      continue;
    }
    const grid = o.answer.grid;
    if (grid === undefined) {
      results = true;
      continue;
    }
    grid.names.forEach((name, i) => {
      if (!types.has(name)) {
        names.push(name);
        types.set(name, grid.types[i]);
      } else if (types.get(name) !== grid.types[i]) {
        types.set(name, 0);
      }
    });
  }
  // A column of the table named `process`, `result` or `error` keeps its
  // name; q-lint's own get a trailing `_` until they are unique.
  const own = (name: string): string => {
    let n = name;
    while (types.has(n)) {
      n = `${n}_`;
    }
    return n;
  };
  const processName = own("process");
  const resultName = own("result");
  const errorName = own("error");
  const columns = [processName, ...names, ...(results ? [resultName] : []), ...(errors ? [errorName] : [])];
  const cells: string[][] = columns.map(() => []);
  const raw: unknown[][] = columns.map(() => []);
  let count = 0;
  const at = new Map(columns.map((c, i) => [c, i]));
  const push = (process: string, values: Map<number, { text: string; raw: unknown }>): void => {
    columns.forEach((_, i) => {
      const v = i === 0 ? { text: process, raw: undefined } : values.get(i);
      cells[i].push(v?.text ?? "");
      raw[i].push(v === undefined ? null : v.raw);
    });
  };
  // Which of the leading columns are keys: a process column, then those
  // every table keys by alike.
  const keyed = outcomes.flatMap((o) => ("answer" in o && o.answer.ok && o.answer.grid !== undefined ? [o.answer.grid] : []));
  const first = keyed[0];
  const keys =
    first !== undefined && first.keys > 0 && keyed.every((g) => g.keys === first.keys && g.names.slice(0, g.keys).join("\u0000") === first.names.slice(0, first.keys).join("\u0000"))
      ? first.keys
      : 0;
  for (const o of outcomes) {
    if ("error" in o) {
      push(o.process, new Map([[at.get(errorName)!, { text: o.error, raw: undefined }]]));
      count++;
      continue;
    }
    const { answer } = o;
    if (!answer.ok) {
      push(o.process, new Map([[at.get(errorName)!, { text: `'${answer.error}`, raw: undefined }]]));
      count++;
      continue;
    }
    const grid = answer.grid;
    if (grid === undefined) {
      push(o.process, new Map([[at.get(resultName)!, { text: answer.text.join("\n"), raw: undefined }]]));
      count++;
      continue;
    }
    const rows = grid.cells[0]?.length ?? 0;
    for (let r = 0; r < rows; r++) {
      const values = new Map<number, { text: string; raw: unknown }>();
      grid.names.forEach((name, i) => {
        const column = grid.raw[i] ?? [];
        values.set(at.get(name)!, { text: grid.cells[i][r] ?? "", raw: column.length === grid.cells[i].length ? column[r] : undefined });
      });
      push(o.process, values);
    }
    count += grid.count;
  }
  const typeOf = (c: string, i: number): number => (i === 0 || c === resultName || c === errorName ? (i === 0 ? 11 : 10) : (types.get(c) ?? 0));
  const columnTypes = columns.map(typeOf);
  // A raw value is kept only where the column has one type and every row
  // gave one: the panel reads a column's numbers only when it has them all.
  const rawOut = raw.map((column, i) =>
    ORDERED.has(columnTypes[i]) && column.every((x) => x !== undefined) ? column : [],
  );
  return {
    count,
    keys: 1 + keys,
    names: columns,
    types: columnTypes,
    cells,
    raw: rawOut,
    rank: columns.map((_, i) => ranks(columnTypes[i], cells[i], rawOut[i])),
  };
}
