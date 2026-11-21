// Saved queries (#912), as data: the names and settings, how the list is
// kept and changed, and how a query's name maps to the document it is
// edited in. No `vscode` import, so node tests it; `savedqueriesview.ts` is
// the VS Code around it.
//
// The list is kept in the workspace's storage (`workspaceState`), not in a
// file, so each workspace has its own and nothing is written into it. A
// query is kept as written, placeholders and all: `{{name}}` is asked for
// each time it runs.

export const SAVED_QUERIES = {
  view: "q-lint.savedQueries",
  save: "q-lint.saveQuery",
  run: "q-lint.runSavedQuery",
  edit: "q-lint.editSavedQuery",
  rename: "q-lint.renameSavedQuery",
  remove: "q-lint.deleteSavedQuery",
} as const;

/// Where the list is kept: `workspaceState`, under this key.
export const SAVED_QUERIES_KEY = "q-lint.savedQueries";
/// The scheme of the documents a saved query is edited in.
export const SAVED_SCHEME = "q-lint-saved";

export interface SavedQuery {
  name: string;
  code: string;
}

export interface SavedQuerySettings {
  enabled: boolean;
}

/// The settings read as `readLive` reads the query ones, at each use.
export function readSavedQueries(get: <T>(key: string, fallback: T) => T): SavedQuerySettings {
  return { enabled: get<unknown>("savedQueries.enable", true) !== false };
}

/// The list as stored, its entries that are not a query dropped, and a
/// name taken twice kept the first time.
export function parseSaved(stored: unknown): SavedQuery[] {
  if (!Array.isArray(stored)) {
    return [];
  }
  const seen = new Set<string>();
  const out: SavedQuery[] = [];
  for (const e of stored) {
    const q = e as Record<string, unknown> | null;
    if (q !== null && typeof q === "object" && typeof q.name === "string" && typeof q.code === "string" && q.name.trim() !== "" && !seen.has(q.name)) {
      seen.add(q.name);
      out.push({ name: q.name, code: q.code });
    }
  }
  return out;
}

/// Why `name` cannot name a saved query, or undefined when it can.
/// `taken` are the names it may not have.
export function nameProblem(name: string, taken: string[]): string | undefined {
  const n = name.trim();
  if (n === "") {
    return "A name is needed.";
  }
  if (/[\r\n]/.test(n)) {
    return "One line.";
  }
  return taken.includes(n) ? "A saved query already has that name." : undefined;
}

/// A name for `code` to start from: its first line, cut.
export function suggestedName(code: string): string {
  const line = code.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 37)}...` : line;
}

/// The list with `query` added at the end, or in place of one of its name.
export function withQuery(list: SavedQuery[], query: SavedQuery): SavedQuery[] {
  return list.some((q) => q.name === query.name) ? list.map((q) => (q.name === query.name ? query : q)) : [...list, query];
}

/// The list with `from` named `to`, in its place.
export function renamed(list: SavedQuery[], from: string, to: string): SavedQuery[] {
  return list.map((q) => (q.name === from ? { ...q, name: to } : q));
}

/// The path of the document `name` is edited in: `/<name>.q`, the name
/// escaped so a `/` or `?` in it is part of it.
export function savedPath(name: string): string {
  return `/${encodeURIComponent(name)}.q`;
}

/// The name a document's path is of, or undefined when it is none.
export function nameOfPath(path: string): string | undefined {
  const m = /^\/(.+)\.q$/.exec(path);
  if (m === null) {
    return undefined;
  }
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}
