// A process's connect script (#916), as data: q code or a q file run on
// every connect, before any query. No `vscode` import, so node tests it;
// `live.ts` runs it and asks for it.
import * as path from "path";
import type { Process } from "./processes";

export const CONNECT_SCRIPT_COMMANDS = {
  set: "q-lint.setConnectScript",
} as const;

export type ConnectScript = { kind: "code"; code: string } | { kind: "file"; file: string };

/// The script `process` runs on connect, if it has one.
export function scriptOf(process: Pick<Process, "init" | "initFile">): ConnectScript | undefined {
  if (process.init !== undefined && process.init.trim() !== "") {
    return { kind: "code", code: process.init };
  }
  if (process.initFile !== undefined && process.initFile.trim() !== "") {
    return { kind: "file", file: process.initFile };
  }
  return undefined;
}

/// `process` running `script` on connect, or none when it is undefined.
export function withScript<P extends Process>(process: P, script: ConnectScript | undefined): P {
  const { init: _init, initFile: _file, ...rest } = process;
  void _init;
  void _file;
  if (script === undefined) {
    return rest as P;
  }
  return (script.kind === "code" ? { ...rest, init: script.code } : { ...rest, initFile: script.file }) as P;
}

/// Where a script file is read from: a leading `~` is the home directory,
/// and a relative path is from `folder`, the first workspace folder.
/// Undefined when it is relative and there is no folder.
export function scriptPath(file: string, home: string, folder: string | undefined): string | undefined {
  const expanded = file === "~" ? home : file.startsWith("~/") || file.startsWith("~\\") ? path.join(home, file.slice(2)) : file;
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return folder === undefined ? undefined : path.resolve(folder, expanded);
}

/// The labels of the processes in `incoming` whose connect script is new,
/// or not the one `before` has: an import is to say it brings code that
/// runs on connect before it is kept.
export function scriptsBrought(before: Process[], incoming: Process[]): string[] {
  const had = new Map(before.map((p) => [p.label, JSON.stringify(scriptOf(p) ?? null)]));
  return incoming.filter((p) => scriptOf(p) !== undefined && had.get(p.label) !== JSON.stringify(scriptOf(p))).map((p) => p.label);
}

/// What a connect script is called in a pick or a message.
export function scriptSummary(script: ConnectScript | undefined): string {
  if (script === undefined) {
    return "none";
  }
  if (script.kind === "file") {
    return `file ${script.file}`;
  }
  const first = script.code.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
  const lines = script.code.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  return `code: ${Array.from(first).length > 60 ? `${Array.from(first).slice(0, 59).join("")}…` : first}${lines > 1 ? ` (+${lines - 1} lines)` : ""}`;
}
