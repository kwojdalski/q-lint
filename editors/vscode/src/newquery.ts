// New Query for Process (#1002), as data: its command, its switch and what
// it says when off. No `vscode` import, so node tests it; `newqueryview.ts`
// opens the editor.

export const NEW_QUERY_COMMAND = "q-lint.newQueryForProcess";

/// `q-lint.processes.newQuery.enable`: whether the command is offered.
export function readNewQuery(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("processes.newQuery.enable", true) !== false };
}

export const NEW_QUERY_OFF = "q-lint: New Query for Process is turned off. Set q-lint.processes.newQuery.enable to true to turn it on.";
