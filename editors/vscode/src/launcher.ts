// The process launcher (#954), as data: what a process's launch definition
// starts, and where. No `vscode` import, so node tests it; `launcherview.ts`
// starts and stops the processes and shows their output.
import * as os from "os";
import { statSync } from "node:fs";
import { scriptPath } from "./connectscript";
import { onPath } from "./relations";
import { quote } from "./terminal";
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

/// What `-p` is given for a process on `host`: a loopback host's port on
/// 127.0.0.1 (its own 127.x address), so a process defined as local is not
/// served on every interface with no password (#1671); any other host's,
/// bare. q binds IPv4 only and takes no `::1:port`, so `::1` is 127.0.0.1.
/// A process in a stack (`peers`) is bare too: TorQ turns a `localhost` in
/// process.csv into .z.h, the machine's name, and its processes connect to
/// each other there, which a loopback-only q refuses (#1742).
export function listenAddress(host: string, port: number, peers = false): string {
  const h = host.trim().toLowerCase();
  if (peers) {
    return String(port);
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) {
    return `${h}:${port}`;
  }
  return h === "localhost" || h === "::1" ? `127.0.0.1:${port}` : String(port);
}

/// Whether a launch's script and arguments start a TorQ process (torq.q,
/// -proctype or -procname): one its stack's other processes connect to by
/// the machine's name (#1742).
export function inStack(script: string | undefined, args: readonly string[]): boolean {
  return (script !== undefined && /(^|[\\/])torq\.q$/i.test(script)) || args.includes("-proctype") || args.includes("-procname");
}

/// The address that tells whether `host`'s process listens: its own 127.x
/// address, which it alone may be bound to (#1742); else 127.0.0.1, which a
/// loopback-only and a bare-port q both answer on.
export function probeHost(host: string): string {
  const h = host.trim().toLowerCase();
  return /^127\.\d+\.\d+\.\d+$/.test(h) ? h : "127.0.0.1";
}

export interface Plan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/// Whether `launch` starts in, or runs a script from, the workspace folder:
/// a relative cwd, or a relative script and no cwd. Saved processes are
/// every window's, so in a workspace not trusted that is the repository's
/// script, run with the user's q (#1527).
export function fromWorkspace(launch: Launch, home: string = os.homedir()): boolean {
  if (launch.cwd !== undefined) {
    return scriptPath(launch.cwd, home, undefined) === undefined;
  }
  return launch.script !== undefined && scriptPath(launch.script, home, undefined) === undefined;
}

/// What starting `process` runs: its command (else `qBinary`), its script,
/// `-p <port>` (on the loopback for a lone q on a loopback host) unless its arguments set one, then its arguments; in its
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
    args: [...(script !== undefined ? [script] : []), ...(args.includes("-p") ? [] : ["-p", listenAddress(process.host, process.port, inStack(launch.script, args))]), ...args],
    cwd,
    env: launch.env ?? {},
  };
}

/// How to spawn `command` with `args` on `platform`. Node will not run a
/// `.bat` or `.cmd` wrapper (q.cmd setting QHOME and QLIC, a common one)
/// without a shell since CVE-2024-27980 - spawn fails with EINVAL (#1680) -
/// so on Windows one is run by cmd.exe, each word quoted for it; one with a
/// `"` or a `%`, which cmd reads itself, is refused. Anything else as it is.
export function spawnPlan(
  command: string,
  args: string[],
  platform: string = globalThis.process.platform,
  comspec: string = globalThis.process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[]; verbatim: boolean } | { error: string } {
  if (platform !== "win32" || !/\.(bat|cmd)$/i.test(command)) {
    return { command, args, verbatim: false };
  }
  const bad = [command, ...args].find((w) => /["%\r\n]/.test(w));
  if (bad !== undefined) {
    return { error: `cmd cannot pass ${JSON.stringify(bad)} to ${command} as written: it reads a " or a % in it itself.` };
  }
  // /s: the outer quotes are taken off and the rest run as it is.
  const line = [command, ...args].map((w) => (w === "" ? '""' : quote(w, "cmd"))).join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
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
