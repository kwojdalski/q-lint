// The process launcher (#954), as data: what a process's launch definition
// starts, and where. No `vscode` import, so node tests it; `launcherview.ts`
// starts and stops the processes and shows their output.
import * as os from "os";
import { scriptPath } from "./connectscript";
import type { Launch, Process } from "./processes";

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
/// relative script or cwd is from the folder. An error when it cannot be started here.
export function launchPlan(process: Process, qBinary: string, folder: string | undefined, home: string = os.homedir()): Plan | { error: string } {
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
  const command = launch.command ?? qBinary;
  return {
    command: /^~([\\/]|$)/.test(command) ? scriptPath(command, home, undefined)! : command,
    args: [...(script !== undefined ? [script] : []), ...(args.includes("-p") ? [] : ["-p", String(process.port)]), ...args],
    cwd,
    env: launch.env ?? {},
  };
}

/// A command line as the output shows it: each argument with a space or a
/// quote in double quotes.
export function commandText(plan: Pick<Plan, "command" | "args">): string {
  return [plan.command, ...plan.args].map((a) => (/[\s"']/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}
