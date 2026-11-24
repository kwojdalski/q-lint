// A process's connect script (#916), as data: q code or a q file run on
// every connect, before any query. No `vscode` import, so node tests it;
// `live.ts` runs it and asks for it.
import * as path from "path";
import type { Process } from "./processes";
import { relativeInside } from "./workspacewrite";

export const CONNECT_SCRIPT_COMMANDS = {
  set: "q-lint.setConnectScript",
} as const;

/// `q-lint.connection.connectScript.enable`: whether scripts run, and can be set.
export function readConnectScript(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("connection.connectScript.enable", true) !== false };
}

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

/// What a process holds that runs, or reaches somewhere, at every connect,
/// beyond the query: its connect script (q code), credential command (a
/// local shell command), launch definition (a local process) and SSH tunnel
/// (where the password goes). The keys an untrusted shared list refuses.
const ON_CONNECT: { name: string; of: (p: Process) => unknown }[] = [
  { name: "connect script", of: (p) => scriptOf(p) },
  { name: "credential command", of: (p) => p.credentialCommand },
  { name: "launch definition", of: (p) => p.launch },
  { name: "SSH tunnel", of: (p) => p.ssh },
];

/// The processes in `incoming` that bring any of those new, or other than
/// the one `before` has, with what they bring: an import asks before taking
/// them (#1108), as `scriptsBrought` does for scripts.
export function onConnectBrought(before: Process[], incoming: Process[]): { label: string; what: string[] }[] {
  const had = new Map(before.map((p) => [p.label, p]));
  return incoming
    .map((p) => {
      const old = had.get(p.label);
      const what = ON_CONNECT.filter(({ of }) => of(p) !== undefined && JSON.stringify((old && of(old)) ?? null) !== JSON.stringify(of(p))).map(({ name }) => name);
      return { label: p.label, what };
    })
    .filter(({ what }) => what.length > 0);
}

/// `process` with the connect script, credential command, launch definition
/// and SSH tunnel `old` has, or none when there is no `old`: an import taken
/// without what it brought.
export function onConnectOf<P extends Process>(process: P, old: Process | undefined): P {
  const { credentialCommand: _c, launch: _l, ssh: _s, ...rest } = withScript(process, old && scriptOf(old));
  void _c;
  void _l;
  void _s;
  return {
    ...rest,
    ...(old?.credentialCommand !== undefined ? { credentialCommand: old.credentialCommand } : {}),
    ...(old?.launch !== undefined ? { launch: old.launch } : {}),
    ...(old?.ssh !== undefined ? { ssh: old.ssh } : {}),
  } as P;
}

/// `process` as the shared list is given it (#1528): with what runs or
/// reaches somewhere at connect (`all`), or without - but always with its SSH
/// tunnel, which holds no secret: without it every clone dials its own
/// host:port, and sends the password there (#1715). A connect script file
/// inside `folder`, kept by its full path here, is written relative to it:
/// the list is read in every clone, where that is where the file is (#1717).
export function sharedEntry<P extends Process>(process: P, all: boolean, folder?: string): P {
  if (all) {
    const relative = process.initFile === undefined || folder === undefined || !path.isAbsolute(process.initFile) ? undefined : relativeInside(folder, process.initFile);
    return relative !== undefined ? { ...process, initFile: relative.split(path.sep).join("/") } : process;
  }
  return { ...onConnectOf(process, undefined), ...(process.ssh !== undefined ? { ssh: process.ssh } : {}) };
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
