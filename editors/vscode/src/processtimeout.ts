// The per-process query timeout and Interrupt Query (#1036), as data. No
// `vscode` import, so node tests it; `live.ts` arms the timeout and
// `timeoutview.ts` registers the commands.
//
// A process's own timeout, while `q-lint.query.processTimeout.enable` is
// on, replaces `q-lint.query.timeout` for queries on it: when it passes,
// the query's connection is dropped, as Abort drops it, and the user told.
// Interrupt Query sends SIGINT to a process the extension started (#954):
// q stops what it is running with `'stop` and keeps the connection, which
// no message over IPC can do.
import type { Process } from "./processes";

/// The seconds a query on `process` may run: its own timeout when it has
/// one and they are on, else the global one (0: no limit).
export function effectiveTimeout(process: Pick<Process, "timeout"> | undefined, global: number, enabled: boolean): number {
  return enabled && process?.timeout !== undefined ? process.timeout : global;
}

/// What names the timeout that applied, for the message a timeout gives.
export function timeoutSource(process: Pick<Process, "label" | "timeout"> | undefined, enabled: boolean): string {
  return enabled && process?.timeout !== undefined ? `${process.label}'s own timeout` : "q-lint.query.timeout";
}

/// Why `text` is not a timeout, or undefined when it is one: empty (none)
/// or positive seconds, at most a day.
export function timeoutProblem(text: string): string | undefined {
  const t = text.trim();
  if (t === "") {
    return undefined;
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 86_400 ? undefined : "Seconds, more than 0 and at most 86400; empty for none.";
}
