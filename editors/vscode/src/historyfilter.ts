// Searching the query history (#913), as data: which entries a filter keeps,
// how the view says what it is filtered by, and the history written to a
// file. No `vscode` import, so node tests it; `live.ts` is the VS Code around
// it.

export const HISTORY_COMMANDS = {
  filter: "q-lint.filterQueryHistory",
  clearFilter: "q-lint.clearQueryHistoryFilter",
  export: "q-lint.exportQueryHistory",
} as const;

/// `q-lint.queryHistory.search.enable`: filtering and exporting at all.
export function readHistorySearch(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("queryHistory.search.enable", true) !== false };
}

/// Set while the Query History view is filtered.
export const HISTORY_FILTERED = "q-lint.queryHistoryFiltered";

/// What a history entry is, as far as filtering and exporting need.
export interface Entry {
  process: string;
  code: string;
  at: string;
  millis: number;
  outcome: "ok" | "error" | "aborted" | "timeout";
  error?: string;
  agent?: true;
}

/// An outcome to keep: one of them, or `failed`, any but `ok`.
export type OutcomeFilter = Entry["outcome"] | "failed";

export interface HistoryFilter {
  process?: string;
  outcome?: OutcomeFilter;
  /// Found, ignoring case, in the code or q's error.
  text?: string;
}

/// The outcome choices Filter Query History offers, in order.
export const OUTCOME_CHOICES: { label: string; outcome: OutcomeFilter | undefined }[] = [
  { label: "Any outcome", outcome: undefined },
  { label: "Succeeded", outcome: "ok" },
  { label: "Failed (error, timeout or aborted)", outcome: "failed" },
  { label: "Error", outcome: "error" },
  { label: "Timed out", outcome: "timeout" },
  { label: "Aborted", outcome: "aborted" },
];

/// `filter` without its empty parts: no process, any outcome, no text.
export function normalised(filter: HistoryFilter): HistoryFilter {
  const text = filter.text?.trim();
  return {
    ...(filter.process !== undefined ? { process: filter.process } : {}),
    ...(filter.outcome !== undefined ? { outcome: filter.outcome } : {}),
    ...(text ? { text } : {}),
  };
}

export function isFiltering(filter: HistoryFilter): boolean {
  return Object.keys(normalised(filter)).length > 0;
}

/// Whether `entry` is kept by `filter`.
export function matches(entry: Entry, filter: HistoryFilter): boolean {
  const { process, outcome, text } = normalised(filter);
  if (process !== undefined && entry.process !== process) {
    return false;
  }
  if (outcome !== undefined && (outcome === "failed" ? entry.outcome === "ok" : entry.outcome !== outcome)) {
    return false;
  }
  if (text !== undefined) {
    const needle = text.toLowerCase();
    return entry.code.toLowerCase().includes(needle) || (entry.error ?? "").toLowerCase().includes(needle);
  }
  return true;
}

/// The entries `filter` keeps, in their order.
export function filtered<T extends Entry>(entries: T[], filter: HistoryFilter): T[] {
  return isFiltering(filter) ? entries.filter((e) => matches(e, filter)) : entries;
}

/// What the view's description says it is filtered by: empty when it is not.
export function filterDescription(filter: HistoryFilter): string {
  const { process, outcome, text } = normalised(filter);
  const said = outcome === undefined ? undefined : OUTCOME_CHOICES.find((c) => c.outcome === outcome)?.label.replace(/ \(.*\)$/, "").toLowerCase();
  return [process, said, text === undefined ? undefined : `"${text}"`].filter((p) => p !== undefined).join(" · ");
}

/// The processes the history names, each once, sorted, for the filter's pick.
export function historyProcesses(entries: Entry[]): string[] {
  return [...new Set(entries.map((e) => e.process))].sort((a, b) => a.localeCompare(b));
}

/// The history as JSON: `{"queries": [...]}`, newest first, each entry as
/// it is kept.
export function historyJson(entries: Entry[]): string {
  const queries = entries.map((e) => ({
    process: e.process,
    at: e.at,
    millis: e.millis,
    outcome: e.outcome,
    ...(e.error !== undefined ? { error: e.error } : {}),
    ...(e.agent ? { agent: true } : {}),
    code: e.code,
  }));
  return JSON.stringify({ queries }, null, 2) + "\n";
}

/// The history as a q script, oldest first so it reads in the order it ran:
/// each query after a comment line naming its process, time, duration and
/// outcome, and its error under it. Its own block comments (`/` ... `\`)
/// are kept as they ran, an end of script (`\` alone) and what follows it in
/// its entry are commented out, and each entry loads as it ran on its own.
export function historyScript(entries: Entry[]): string {
  const comment = (text: string): string => `/ ${text.replace(/\r?\n/g, " ")}`;
  return (
    [...entries]
      .reverse()
      .map((e) =>
        [
          comment(`${e.process}, ${e.at}, ${e.millis} ms, ${e.outcome}${e.agent ? ", run by an agent" : ""}`),
          ...(e.error !== undefined && e.outcome !== "ok" ? [comment(`'${e.error}`)] : []),
          standalone(e.code.replace(/\r?\n$/, "")),
        ].join("\n"),
      )
      .join("\n\n") + "\n"
  );
}

/// `code` made to load in a script as it ran on its own (#1098): the line
/// that starts its first statement unindented, so it does not continue the
/// entry above, and a block comment it leaves open closed, so it does not
/// hide the entries below. The rules are `statements.ts`'s.
function standalone(code: string): string {
  const lines = code.split("\n");
  let inBlock = false;
  let started = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (inBlock) {
      inBlock = line !== "\\";
    } else if (line === "/") {
      inBlock = true;
    } else if (line === "\\") {
      // The end of the script ended this entry when it ran, and would end
      // the export here: it and the rest of the entry become comments (#1136).
      return lines.map((l, j) => (j < i || l.trim() === "" ? l : `/ ${l}`)).join("\n");
    } else if (!started && line.trim() !== "" && !line.startsWith("/")) {
      lines[i] = lines[i].trimStart();
      started = true;
    }
  }
  return inBlock ? `${lines.join("\n")}\n\\` : lines.join("\n");
}

/// Which format a file is written in, from its name: a `.q` file the
/// script, anything else JSON.
export function exportFormat(file: string): "q" | "json" {
  return /\.q$/i.test(file) ? "q" : "json";
}
