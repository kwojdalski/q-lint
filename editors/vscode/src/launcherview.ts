// Start and Stop Process (#954): local q and TorQ processes started from
// their launch definition, each with its output in an output channel of its
// own, and stopped when VS Code closes. What is started is `launcher.ts`'s;
// only a process the user gave a definition, and asked to start, is.
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import { commands, window, workspace, type ExtensionContext, type OutputChannel } from "vscode";
import { LAUNCH_COMMANDS, argsFromText, argsText, commandText, fromWorkspace, launchPlan, listenAddress, probeHost, readLauncher, spawnPlan } from "./launcher";
import { readTerminal } from "./liveconfig";
import { qBinaryFrom, relativeBinaryProblem } from "./terminal";
import { mergeEnv } from "./qenv";
import { dotenvFor, layoutEnvFor } from "./qenvironment";
import type { Live, ProcessArg } from "./live";
import { launchOf, withExtras, type Launch, type Process } from "./processes";
import { iconsEscaped, plainMessage } from "./history";
import { groupAlive, lifeline, signalGroup } from "./lifeline";

/// How long a process has to end after SIGTERM before it is killed.
const STOP_GRACE_MS = 3000;

interface Started {
  child: ChildProcess;
  channel: OutputChannel;
  port: number;
}

/// Whether something accepts connections on `port` of `host`'s loopback
/// address (probeHost).
function listening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, probeHost(host), () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export class Launcher {
  private readonly started = new Map<string, Started>();
  private readonly channels = new Map<string, OutputChannel>();
  /// The labels being started: held from before the first await, so a
  /// second Start while one is on its way is refused, not spawned (#1249).
  private readonly starting = new Set<string>();
  /// Set when VS Code closes: a Start still on its way spawns nothing.
  private disposed = false;

  constructor(
    context: ExtensionContext,
    private readonly live: Live,
  ) {
    live.launched = (label) => this.started.has(label);
    live.relabelled = (from, to) => this.relabel(from, to);
    context.subscriptions.push(
      commands.registerCommand(LAUNCH_COMMANDS.start, (row?: ProcessArg) => this.start(row)),
      commands.registerCommand(LAUNCH_COMMANDS.stop, (row?: ProcessArg) => this.stop(row)),
      commands.registerCommand(LAUNCH_COMMANDS.set, (row?: ProcessArg, launch?: Launch | null) => this.setDefinition(row, launch)),
      workspace.onDidChangeConfiguration((event) => {
        // Turned off, what it started is stopped: nothing of it is left.
        if (event.affectsConfiguration("q-lint.processes.launcher") && !this.enabled()) {
          this.stopAll();
        }
      }),
      { dispose: () => ((this.disposed = true), this.stopAll()) },
    );
  }

  /// Keep what was started as `from` under `to`, its new label (#1692).
  private relabel(from: string, to: string): void {
    const started = this.started.get(from);
    if (started !== undefined && !this.started.has(to)) {
      this.started.delete(from);
      this.started.set(to, started);
    }
  }

  /// The processes running from here, by label, for tests and the e2e run.
  running(): { label: string; pid: number | undefined; port: number }[] {
    return [...this.started].map(([label, s]) => ({ label, pid: s.child.pid, port: s.port }));
  }

  /// Interrupt what `label`, started from here, is running (#1036): SIGINT,
  /// which q answers by stopping the call it is in with 'stop and running
  /// on. The pid sent it, or undefined when `label` is not running from here,
  /// or on Windows, where kill() ends the process whatever the signal (#1250).
  interrupt(label: string): number | undefined {
    const child = this.started.get(label)?.child;
    if (globalThis.process.platform === "win32" || child === undefined || child.pid === undefined || ((child.exitCode !== null || child.signalCode !== null) && !groupAlive(child))) {
      return undefined;
    }
    signalGroup(child, "SIGINT");
    return child.pid;
  }

  private enabled(say = false): boolean {
    const configuration = workspace.getConfiguration("q-lint");
    const { enabled } = readLauncher((key, fallback) => configuration.get(key, fallback));
    if (!enabled && say) {
      void window.showInformationMessage("q-lint: The process launcher is turned off. Set q-lint.processes.launcher.enable to true to turn it on.");
    }
    return enabled;
  }

  private channel(label: string): OutputChannel {
    let channel = this.channels.get(label);
    if (channel === undefined) {
      channel = window.createOutputChannel(`q: ${label}`);
      this.channels.set(label, channel);
    }
    return channel;
  }

  private async start(row?: ProcessArg): Promise<void> {
    if (!this.enabled(true)) {
      return;
    }
    const process = await this.live.pick(row, "Start which q process?");
    if (process === undefined) {
      return;
    }
    if (this.started.has(process.label) || this.starting.has(process.label)) {
      void window.showInformationMessage(plainMessage(`q-lint: ${process.label} is already running from here.`));
      return;
    }
    this.starting.add(process.label);
    let problem: string | undefined;
    try {
      problem = await this.launch(process);
    } finally {
      this.starting.delete(process.label);
    }
    if (problem !== undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: ${problem}`));
      return;
    }
    void window.showInformationMessage(plainMessage(`q-lint: started ${process.label} (pid ${this.started.get(process.label)?.child.pid ?? "?"}) on port ${process.port}.`));
  }

  /// Stop `label`, which was started from here, start it again from its
  /// launch definition, and wait until it listens on its port: for Restart
  /// Notebook Process and Run All (#1000). Why it could not, or undefined
  /// once it listens.
  async restart(label: string, timeoutMs = 15_000): Promise<string | undefined> {
    if (!this.enabled()) {
      return "the process launcher is turned off (q-lint.processes.launcher.enable).";
    }
    const process = this.live.processes().find((p) => p.label === label);
    if (!this.started.has(label) || process === undefined) {
      return `${label} was not started from here, so it is not restarted from here.`;
    }
    if (this.starting.has(label)) {
      return `${label} is already being started.`;
    }
    this.starting.add(label);
    let problem: string | undefined;
    try {
      await this.end(label);
      problem = await this.launch(process);
    } finally {
      this.starting.delete(label);
    }
    if (problem !== undefined) {
      return problem;
    }
    const child = this.started.get(label)?.child;
    const until = Date.now() + timeoutMs;
    while (!(await listening(process.port, process.host))) {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null || this.started.get(label)?.child !== child) {
        return `${label} ended before it listened on port ${process.port}: its output is in the "q: ${label}" output channel.`;
      }
      if (Date.now() > until) {
        return `${label} did not listen on port ${process.port} within ${timeoutMs / 1000} s.`;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  /// Start `process` from its launch definition. Why it could not, or
  /// undefined once it is spawned.
  private async launch(process: Process): Promise<string | undefined> {
    const configuration = workspace.getConfiguration("q-lint", workspace.workspaceFolders?.[0]?.uri);
    const { qBinary } = readTerminal((key, fallback) => configuration.get(key, fallback));
    if (workspace.isTrusted === false && process.launch !== undefined && fromWorkspace(process.launch)) {
      return `${process.label}'s working directory or script is relative to the workspace folder, which is not trusted: it was not started. Name them by their full paths.`;
    }
    // A relative q binary is the folder's, as in the terminals, not the
    // launch's working directory's (#1540).
    const trusted = workspace.isTrusted !== false;
    const binary = process.launch?.command !== undefined ? qBinary : qBinaryFrom(qBinary, workspace.workspaceFolders?.[0]?.uri.fsPath, os.homedir(), trusted);
    if (binary === undefined) {
      return `${relativeBinaryProblem(qBinary, trusted)}; ${process.label} was not started.`;
    }
    const plan = launchPlan(process, binary, workspace.workspaceFolders?.[0]?.uri.fsPath);
    if ("error" in plan) {
      return plan.error;
    }
    // A process already on the port would make this one fail to listen.
    if (await listening(process.port, process.host)) {
      return `something already listens on port ${process.port}; ${process.label} was not started.`;
    }
    // The binary's layout's variables, then the workspace's .env file's,
    // then the definition's own; the output shows none of their values.
    const folder = workspace.workspaceFolders?.[0]?.uri;
    const env = mergeEnv(layoutEnvFor(plan.command, folder), await dotenvFor(folder), plan.env);
    // Turned off, or VS Code closing, while it waited: stopAll has run over
    // what was started, and would not stop this one (#1434).
    if (this.disposed || !this.enabled()) {
      return `the process launcher was turned off; ${process.label} was not started.`;
    }
    const channel = this.channel(process.label);
    channel.appendLine(`$ ${commandText(plan)}    (in ${plan.cwd})`);
    channel.show(true);
    const run = spawnPlan(plan.command, plan.args);
    if ("error" in run) {
      channel.appendLine(`could not start: ${run.error}`);
      return `could not start ${process.label}: ${run.error}`;
    }
    let child: ChildProcess;
    try {
      child = spawn(run.command, run.args, {
        windowsVerbatimArguments: run.verbatim,
        cwd: plan.cwd,
        env: { ...globalThis.process.env, ...env },
        // No stdin: q reads none from a launcher, and keeps running without.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // A process group of its own, so Stop reaches the q a wrapper
        // script starts as well as the script (#1672).
        detached: globalThis.process.platform !== "win32",
      });
    } catch (error) {
      channel.appendLine(`could not start: ${error instanceof Error ? error.message : String(error)}`);
      return `could not start ${process.label}: ${error instanceof Error ? error.message : String(error)}`;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => channel.append(text));
    child.stderr?.on("data", (text: string) => channel.append(text));
    // A missing or not executable program is an 'error' after spawn()
    // returns: it is the problem, and nothing was started (#1679).
    const failed = await new Promise<Error | undefined>((resolve) => {
      child.once("spawn", () => resolve(undefined));
      child.once("error", resolve);
    });
    if (failed !== undefined) {
      channel.appendLine(`could not start: ${failed.message}`);
      return `could not start ${process.label}: ${failed.message}`;
    }
    child.on("error", (error) => channel.appendLine(error.message));
    // Turned off while it spawned, too: stopAll has run already (#1740).
    if (this.disposed || !this.enabled()) {
      signalGroup(child, "SIGKILL");
      return `the process launcher was turned off; ${process.label} was not started.`;
    }
    const started: Started = { child, channel, port: process.port };
    this.started.set(process.label, started);
    // Ended with the extension host, even when it is killed (#1676).
    lifeline(child);
    child.once("close", (code, signal) => {
      // Under the label it has now, which a rename may have changed.
      for (const [label, s] of this.started) {
        if (s.child === child) {
          this.started.delete(label);
        }
      }
      channel.appendLine(`[${process.label} ended: ${signal !== null ? `stopped by ${signal}` : `exit code ${code}`}]`);
      this.live.refreshProcesses();
    });
    this.live.refreshProcesses();
    return undefined;
  }

  private async stop(row?: ProcessArg): Promise<void> {
    if (!this.enabled(true)) {
      return;
    }
    let label: string | undefined;
    if (row === undefined) {
      const running = [...this.started.keys()];
      if (running.length === 0) {
        void window.showInformationMessage("q-lint: no process started from here is running.");
        return;
      }
      label = running.length === 1 ? running[0] : (await window.showQuickPick(running.map((r) => ({ label: iconsEscaped(r), name: r })), { title: "Stop which q process?" }))?.name;
    } else {
      label = (await this.live.pick(row, "Stop which q process?"))?.label;
    }
    if (label === undefined) {
      return;
    }
    if (!this.started.has(label)) {
      void window.showInformationMessage(plainMessage(`q-lint: ${label} was not started from here, so it is not stopped from here.`));
      return;
    }
    await this.end(label);
  }

  /// Stop `label`: SIGTERM to its process group, then SIGKILL if it has
  /// not ended in a while. Done once its output closes, which is once every
  /// process holding it has ended, or a while after the SIGKILL.
  private end(label: string): Promise<void> {
    const started = this.started.get(label);
    if (started === undefined) {
      return Promise.resolve();
    }
    const { child } = started;
    return new Promise((resolve) => {
      // An exited wrapper may have left its q in its group (#1744).
      if ((child.exitCode !== null || child.signalCode !== null) && !groupAlive(child)) {
        resolve();
        return;
      }
      let last: NodeJS.Timeout | undefined;
      const kill = setTimeout(() => {
        signalGroup(child, "SIGKILL");
        // Something outside its group may hold its output open.
        last = setTimeout(() => {
          if (this.started.get(label)?.child === child) {
            this.started.delete(label);
            this.live.refreshProcesses();
          }
          resolve();
        }, STOP_GRACE_MS);
        last.unref();
      }, STOP_GRACE_MS);
      kill.unref();
      child.once("close", () => {
        clearTimeout(kill);
        clearTimeout(last);
        resolve();
      });
      signalGroup(child, "SIGTERM");
    });
  }

  /// Stop everything started from here, and close the output channels once
  /// each has ended, so their last lines are in them first (#1433).
  private stopAll(): void {
    const channels = [...this.channels.values()];
    this.channels.clear();
    void Promise.all([...this.started.keys()].map((label) => this.end(label))).then(() => {
      for (const channel of channels) {
        channel.dispose();
      }
    });
  }

  /// Give a saved process a launch definition, or remove it. `launch` (from
  /// a keybinding or a test) sets it without asking; `null` removes it.
  private async setDefinition(row?: ProcessArg, given?: Launch | null): Promise<void> {
    if (!this.enabled(true)) {
      return;
    }
    const process = await this.live.pick(row, "Set the launch definition of which q process?");
    if (process === undefined) {
      return;
    }
    if (process.server !== undefined) {
      void window.showInformationMessage("q-lint: a listed process is not saved, so it has no launch definition of its own.");
      return;
    }
    let launch: Launch | undefined;
    if (given === null) {
      launch = undefined;
    } else if (given !== undefined) {
      launch = launchOf(given);
    } else {
      const current = process.launch ?? {};
      const command = await window.showInputBox({
        title: `Launch ${process.label} (1 of 3): program`,
        value: current.command ?? "",
        prompt: "The program to run. Empty: q-lint.terminal.qBinary (q).",
        ignoreFocusOut: true,
      });
      if (command === undefined) {
        return;
      }
      const script = await window.showInputBox({
        title: `Launch ${process.label} (2 of 3): script`,
        value: current.script ?? "",
        prompt: "The q script it loads, relative to the workspace folder or absolute: server.q, or torq.q for TorQ. Empty: none.",
        ignoreFocusOut: true,
      });
      if (script === undefined) {
        return;
      }
      const args = await window.showInputBox({
        title: `Launch ${process.label} (3 of 3): arguments`,
        value: argsText(current.args ?? []),
        prompt: `Arguments after the script; -p ${listenAddress(process.host, process.port)} (a bare port for TorQ) is added unless they set -p. For TorQ: -proctype rdb -procname rdb1 -load code/processes/rdb.q`,
        ignoreFocusOut: true,
      });
      if (args === undefined) {
        return;
      }
      launch = launchOf({ ...current, command, script, args: argsFromText(args, current.args ?? []) });
    }
    const now = this.live.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(plainMessage(`q-lint: "${process.label}" was deleted meanwhile; its launch definition was not set.`));
      return;
    }
    await this.live.saveProcesses(now.map((p) => (p.label === process.label ? withExtras(p, { ...p, launch }) : p)));
    void window.showInformationMessage(
      plainMessage(launch === undefined ? `q-lint: ${process.label} has no launch definition.` : `q-lint: Start Process starts ${process.label}.`),
    );
  }
}
