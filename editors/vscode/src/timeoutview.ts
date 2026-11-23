// Set Process Timeout and Interrupt Query (#1036). The timeout is kept with
// the process and armed by `Live.run`; Interrupt Query sends SIGINT to the
// connected process when the extension started it, so the query stops on
// the process with 'stop and the connection stays - unlike Abort, which can
// only drop the connection. It sends no code, so the read-only guard has
// nothing to read.
import { commands, window, workspace, type ExtensionContext } from "vscode";
import { ADMIN_COMMANDS, adminOff, readAdmin } from "./admin";
import type { Launcher } from "./launcherview";
import type { Live, ProcessArg } from "./live";
import { timeoutOf, withExtras } from "./processes";
import { timeoutProblem } from "./processtimeout";

const settings = () => readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback));

export class ProcessTimeouts {
  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "pick" | "processes" | "saveProcesses" | "activeProcess" | "isBusy">,
    private readonly launcher: Pick<Launcher, "interrupt">,
  ) {
    context.subscriptions.push(
      commands.registerCommand(ADMIN_COMMANDS.setTimeout, (row?: ProcessArg, seconds?: number | null) => this.setTimeout(row, seconds)),
      commands.registerCommand(ADMIN_COMMANDS.interrupt, () => this.interrupt()),
    );
  }

  /// Set `row`'s timeout, or a picked process's; `seconds` (from a
  /// keybinding or a test) sets it without asking, `null` or 0 clears it.
  async setTimeout(row?: ProcessArg, seconds?: number | null): Promise<void> {
    if (!settings().processTimeout) {
      void window.showInformationMessage(adminOff("processTimeout"));
      return;
    }
    const process = await this.live.pick(row, "Set the query timeout of which q process?");
    if (process === undefined) {
      return;
    }
    if (process.server !== undefined) {
      void window.showInformationMessage("q-lint: a listed process is not saved, so it has no timeout of its own.");
      return;
    }
    let timeout: number | undefined;
    if (seconds === null) {
      timeout = undefined;
    } else if (typeof seconds === "number") {
      timeout = timeoutOf(seconds);
    } else {
      const text = await window.showInputBox({
        title: `Query timeout of ${process.label}`,
        value: process.timeout === undefined ? "" : String(process.timeout),
        prompt: "Seconds a query on it may run before its connection is dropped; over q-lint.query.timeout. Empty: q-lint.query.timeout applies.",
        validateInput: timeoutProblem,
      });
      if (text === undefined) {
        return;
      }
      timeout = text.trim() === "" ? undefined : timeoutOf(Number(text));
    }
    const now = this.live.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(`q-lint: "${process.label}" was deleted meanwhile; its timeout was not set.`);
      return;
    }
    await this.live.saveProcesses(
      now.map((p) => {
        if (p.label !== process.label) {
          return p;
        }
        const { timeout: _old, ...rest } = p;
        void _old;
        return withExtras({ ...rest }, { ...rest, ...(timeout !== undefined ? { timeout } : {}) });
      }),
    );
    void window.showInformationMessage(
      timeout === undefined ? `q-lint: queries on ${process.label} follow q-lint.query.timeout.` : `q-lint: a query on ${process.label} is dropped after ${timeout} s.`,
    );
  }

  /// Interrupt the query running on the connected process, when it was
  /// started from here. The pid signalled, for tests.
  interrupt(): number | undefined {
    if (!settings().cancelLocal) {
      void window.showInformationMessage(adminOff("cancelLocal"));
      return undefined;
    }
    const process = this.live.activeProcess();
    if (process === undefined || !this.live.isBusy()) {
      void window.showInformationMessage("q-lint: no query is running.");
      return undefined;
    }
    // Node sends no SIGINT on Windows: kill() there ends the process
    // whatever the signal, and q with it (#1250).
    if (globalThis.process.platform === "win32") {
      void window.showInformationMessage(
        "q-lint: a q process cannot be interrupted on Windows: a signal there ends it. q-lint: Abort Current Query stops waiting for the query instead.",
      );
      return undefined;
    }
    const pid = process.server === undefined ? this.launcher.interrupt(process.label) : undefined;
    if (pid === undefined) {
      void window.showInformationMessage(
        `q-lint: ${process.label} was not started from here (Start Process), so it cannot be interrupted from here. q-lint: Abort Current Query stops waiting for the query instead.`,
      );
      return undefined;
    }
    void window.showInformationMessage(`q-lint: interrupted ${process.label} (pid ${pid}); its query stops with 'stop and the connection stays.`);
    return pid;
  }
}
