// The process launcher (#954), as data: what a process's launch definition
// starts, and where. No `vscode` import, so node tests it; `launcherview.ts`
// starts and stops the processes and shows their output.
import * as os from "os";
import { statSync } from "node:fs";
import { scriptPath } from "./connectscript";
import { onPath } from "./relations";
import { splitArgs, type Launch, type Process } from "./processes";

export const LAUNCH_COMMANDS = {
  set: "q-lint.setLaunchDefinition",
  start: "q-lint.startProcess",
  stop: "q-lint.stopProcess",
} as const;

/// `q-lint.processes.launcher.enable`: whether processes can be started and
/// stopped from the Processes view.
export function readLauncher(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("processes.launcher.enable", true) !== false };
}

/// Whether `host` is this machine: only a process here can be started.
export function isLocalHost(host: string, hostname: string = os.hostname()): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "0.0.0.0" || h === hostname.toLowerCase();
}

export interface Plan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/// What starting `process` runs: its command (else `qBinary`), its script,
/// `-p <port>` unless its arguments set one, then its arguments; in its
/// `cwd`, else the workspace folder, else the home directory. A leading `~`
/// (`~/`, or `~\` as Windows writes it) is the home directory, and a
/// relative script or cwd is from the folder. A bare program name is found
/// by `find`: on Windows in PATH's directories, never in the one it starts
/// in, which is the workspace folder (#1286). An error when it cannot be
/// started here.
export function launchPlan(
  process: Process,
  qBinary: string,
  folder: string | undefined,
  home: string = os.homedir(),
  find: (binary: string) => string | undefined = (binary) => onPath(binary, globalThis.process.env.PATH, isFile),
): Plan | { error: string } {
  const launch: Launch | undefined = process.launch;
  if (launch === undefined) {
    return { error: `${process.label} has no launch definition. Set Launch Definition gives it one.` };
  }
  if (!isLocalHost(process.host)) {
    return { error: `${process.label} is on ${process.host}, not this machine: only a local process can be started.` };
  }
  const cwd = launch.cwd !== undefined ? scriptPath(launch.cwd, home, folder) : (folder ?? home);
  if (cwd === undefined) {
    return { error: `${process.label}'s working directory ${launch.cwd} is relative, and there is no workspace folder.` };
  }
  let script: string | undefined;
  if (launch.script !== undefined) {
    script = scriptPath(launch.script, home, cwd);
  }
  const args = launch.args ?? [];
  const named = launch.command ?? qBinary;
  const command = /^~([\\/]|$)/.test(named) ? scriptPath(named, home, undefined)! : find(named);
  if (command === undefined) {
    return { error: `${named} is not on PATH, so ${process.label} was not started: name the program by its path.` };
  }
  return {
    command,
    args: [...(script !== undefined ? [script] : []), ...(args.includes("-p") ? [] : ["-p", String(process.port)]), ...args],
    cwd,
    env: launch.env ?? {},
  };
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/// A command line as the output shows it: each argument with a space or a
/// quote in double quotes.
export function commandText(plan: Pick<Plan, "command" | "args">): string {
  return [plan.command, ...plan.args].map((a) => (/[\s"']/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

/// The arguments as Set Launch Definition's Arguments box shows them: one
/// with a space, or empty, in double quotes.
export function argsText(args: string[]): string {
  return args.map((a) => (/\s/.test(a) || a === "" ? `"${a}"` : a)).join(" ");
}

/// The arguments the box's `text` gives: `args` as they were when it is the
/// text they were shown as, so one holding a quote is not split (#1430).
export function argsFromText(text: string, args: string[]): string[] {
  return text === argsText(args) ? args : splitArgs(text);
}
