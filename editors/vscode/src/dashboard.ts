// Dashboards of saved queries (#1030), as data: the dashboards and their
// tiles, how they are kept and changed, and what a tile shows. Free of any
// `vscode` import, so node tests it; `dashboardview.ts` is the panel.
//
// A tile is a saved query, by name, on a saved process, by label, shown as
// a table or a chart, refreshed every so many seconds or - the default -
// only when asked. The dashboards are kept in the workspace's storage
// (`workspaceState`), as saved queries are, so nothing is written into the
// workspace. A tile runs only a query the read-only guard reads as
// changing nothing, and none with a `{{placeholder}}`, which a refresh
// could not ask for.
import { writes } from "./guard";

/// Where the dashboards are kept: `workspaceState`, under this key.
export const DASHBOARDS_KEY = "q-lint.dashboards";

export const TILE_VIEWS = ["table", "line", "bar", "area", "step", "scatter"] as const;
export type TileView = (typeof TILE_VIEWS)[number];

/// The refresh intervals a tile offers, in seconds; 0 is off.
export const REFRESH_CHOICES = [0, 5, 10, 30, 60, 300, 900];
/// The shortest interval a tile takes.
export const MIN_REFRESH = 5;

export interface Tile {
  id: string;
  query: string;
  process: string;
  view: TileView;
  refresh: number;
}

export interface Dashboard {
  name: string;
  /// Tiles a row, 1 to 4.
  columns: number;
  tiles: Tile[];
}

const isTile = (t: unknown): t is Tile => {
  const x = t as Record<string, unknown> | null;
  return x !== null && typeof x === "object" && typeof x.id === "string" && typeof x.query === "string" && typeof x.process === "string";
};

/// The dashboards as stored, anything that is not one dropped, a name
/// taken twice kept the first time, and every value made one it can be.
export function parseDashboards(stored: unknown): Dashboard[] {
  if (!Array.isArray(stored)) return [];
  const out: Dashboard[] = [];
  for (const d of stored) {
    const x = d as Record<string, unknown> | null;
    if (x === null || typeof x !== "object" || typeof x.name !== "string" || x.name.trim() === "" || out.some((o) => o.name === x.name)) continue;
    const tiles = Array.isArray(x.tiles) ? x.tiles.filter(isTile).map((t) => ({ ...t, view: TILE_VIEWS.includes(t.view) ? t.view : "table", refresh: refreshOf(t.refresh) })) : [];
    out.push({ name: x.name, columns: columnsOf(x.columns), tiles });
  }
  return out;
}

/// An interval as a tile keeps it: whole seconds, 0 or at least `MIN_REFRESH`.
export function refreshOf(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return n <= 0 ? 0 : Math.max(MIN_REFRESH, n);
}
const columnsOf = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? Math.min(4, Math.max(1, v)) : 2);

/// Why a dashboard cannot be named `name`; undefined when it can.
export function dashboardNameProblem(name: string, taken: string[]): string | undefined {
  const n = name.trim();
  if (n === "") return "A dashboard needs a name";
  if (n.length > 80) return "At most 80 characters";
  if (taken.includes(n)) return `There is already a dashboard ${n}`;
  return undefined;
}

/// Why `code` cannot be a tile's query; undefined when it can.
export function tileQueryProblem(code: string): string | undefined {
  if (/\{\{\s*[A-Za-z_]\w*\s*\}\}/.test(code)) return "it has a {{placeholder}}, which a refresh cannot ask for";
  const w = writes(code);
  if (w.length > 0) return `a dashboard runs read-only queries only, and this one would change the process (${w.join("; ")})`;
  return undefined;
}

/// `list` with dashboard `d` in place of the one of its name, or added.
export function withDashboard(list: Dashboard[], d: Dashboard): Dashboard[] {
  const at = list.findIndex((x) => x.name === d.name);
  return at < 0 ? [...list, d] : list.map((x, i) => (i === at ? d : x));
}

/// A change the panel asks for.
export type TileChange =
  | { type: "refresh-interval"; id: string; seconds: number }
  | { type: "view"; id: string; view: string }
  | { type: "move"; id: string; by: -1 | 1 }
  | { type: "remove"; id: string }
  | { type: "columns"; columns: number };

/// `d` with `change` made; unchanged for a change that names no tile.
export function changed(d: Dashboard, change: TileChange): Dashboard {
  switch (change.type) {
    case "columns":
      return { ...d, columns: columnsOf(change.columns) };
    case "refresh-interval":
      return { ...d, tiles: d.tiles.map((t) => (t.id === change.id ? { ...t, refresh: refreshOf(change.seconds) } : t)) };
    case "view":
      return { ...d, tiles: d.tiles.map((t) => (t.id === change.id && TILE_VIEWS.includes(change.view as TileView) ? { ...t, view: change.view as TileView } : t)) };
    case "remove":
      return { ...d, tiles: d.tiles.filter((t) => t.id !== change.id) };
    case "move": {
      const at = d.tiles.findIndex((t) => t.id === change.id);
      const to = at + change.by;
      if (at < 0 || to < 0 || to >= d.tiles.length) return d;
      const tiles = [...d.tiles];
      [tiles[at], tiles[to]] = [tiles[to], tiles[at]];
      return { ...d, tiles };
    }
  }
}

/// Rows a table tile shows at most.
export const TILE_ROWS = 200;

/// What a tile shows after a run: a table's first rows, a chart's SVG,
/// text, or why it could not run.
export type TileContent =
  | { kind: "table"; columns: string[]; rows: string[][]; total: number }
  | { kind: "chart"; svg: string; total: number }
  | { kind: "text"; text: string }
  | { kind: "error"; text: string };
