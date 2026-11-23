// Set Credential Command (#1034): give a saved process a command whose
// output is its user and password at each connect, or take it away. The
// command is kept with the process, as its launch definition is; what it
// prints is never kept (`credentials.ts`, `Live.targetFor`).
import { commands, window, workspace, type ExtensionContext } from "vscode";
import { ADMIN_COMMANDS, adminOff, readAdmin } from "./admin";
import type { Live, ProcessArg } from "./live";
import { credentialCommandOf, withExtras } from "./processes";
import { plainMessage } from "./history";

const on = (): boolean => readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).credentialCommand;

export class CredentialCommands {
  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "pick" | "processes" | "saveProcesses">,
  ) {
    context.subscriptions.push(
      commands.registerCommand(ADMIN_COMMANDS.setCredentialCommand, (row?: ProcessArg, command?: string | null) => this.set(row, command)),
    );
  }

  /// Set `row`'s command, or a picked process's; `command` (from a
  /// keybinding or a test) sets it without asking, `""` or `null` clears it.
  async set(row?: ProcessArg, command?: string | null): Promise<void> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("credentialCommand")));
      return;
    }
    const process = await this.live.pick(row, "Set the credential command of which q process?");
    if (process === undefined) {
      return;
    }
    if (process.server !== undefined) {
      void window.showInformationMessage("q-lint: a listed process is not saved, so it has no credential command of its own.");
      return;
    }
    let given = command === null ? "" : command;
    if (typeof given !== "string") {
      given = await window.showInputBox({
        title: `Credential command of ${process.label}`,
        value: process.credentialCommand ?? "",
        prompt:
          "Run in a shell at each connect. It prints a JSON object with password (or token) and optionally user, or a line: the password, or user:password. QLINT_PROCESS_LABEL, _HOST, _PORT and _USER are set. What it prints is used for that connect only, never stored. Empty: use the stored password.",
        ignoreFocusOut: true,
      });
      if (given === undefined) {
        return;
      }
    }
    const credentialCommand = credentialCommandOf(given);
    const now = this.live.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(plainMessage(`q-lint: "${process.label}" was deleted meanwhile; its credential command was not set.`));
      return;
    }
    await this.live.saveProcesses(
      now.map((p) => {
        if (p.label !== process.label) {
          return p;
        }
        const { credentialCommand: _old, ...rest } = p;
        void _old;
        return withExtras({ ...rest }, { ...rest, ...(credentialCommand !== undefined ? { credentialCommand } : {}) });
      }),
    );
    void window.showInformationMessage(
      plainMessage(credentialCommand === undefined
        ? `q-lint: ${process.label} connects with its stored password.`
        : `q-lint: ${process.label} runs its credential command at each connect.`),
    );
  }
}
