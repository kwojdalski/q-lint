// The q interpreter picker (#974) and the licence expiry warning (#975).
//
// **Select q Interpreter** lists the q binaries `interpreter.ts` finds,
// each with the version it answers, and sets the one picked as the
// workspace's `q-lint.terminal.qBinary` - what the q terminals, the
// process launcher and the q tasks start. A status bar item beside a q
// editor shows it. Only opening the picker, or **Check q Licence Expiry**,
// starts a q: each found binary once, with `-q`, to print its version and
// exit. Nothing is sent to a process, and nothing leaves the machine.
//
// The licence's expiry date is the one q itself reports in `.z.l`, as
// code.kx.com documents it: the licence files are not in a format KX
// publishes, so they are located (to notice one replaced) and never read.
// What the probe learnt is kept per binary; on start, and when the binary
// changes, a licence within `q-lint.licence.warningDays` of its date is
// warned of once a day from what was kept, with no q started.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfigurationTarget,
  StatusBarAlignment,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type QuickPickItem,
  type StatusBarItem,
  type Uri,
} from "vscode";
import {
  INTERPRETER_COMMANDS,
  PROBE,
  daysLeft,
  discover,
  expiryWarning,
  licenceFile,
  readInterpreter,
  readProbe,
  versionText,
  type Probe,
} from "./interpreter";
import { readTerminal } from "./liveconfig";
import { mergeEnv } from "./qenv";
import { dotenvFor, layoutEnvFor, nodeFiles } from "./qenvironment";
import { qBinaryFrom } from "./terminal";
import { iconsEscaped, plainMessage } from "./history";

/// How long a binary has to answer the probe.
export const PROBE_TIMEOUT_MS = 10_000;

const PROBES_KEY = "q-lint.interpreter.probes";
const WARNED_KEY = "q-lint.licence.warned";

/// What one probe learnt, kept per binary path.
interface Kept extends Probe {
  /// The licence file q would read then, and when it was last changed.
  licence?: { file: string; mtime: number };
}

/// The file the settings are read for: the active editor's, as a q terminal
/// started from it reads them - in a multi-root workspace a folder may set
/// its own q binary (#1333).
const resource = (): Uri | undefined => window.activeTextEditor?.document.uri;
const get = <T>(key: string, fallback: T): T => workspace.getConfiguration("q-lint", resource()).get(key, fallback);

/// Run `binary` with the probe on its stdin, and read what it printed.
export function probe(binary: string, env: Record<string, string>): Promise<Probe | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: Probe | undefined): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["-q"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(readProbe(out));
    }, PROBE_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => (out += text));
    child.stdin?.on("error", () => {});
    child.once("error", () => finish(undefined));
    child.once("close", () => finish(readProbe(out)));
    child.stdin?.end(PROBE);
  });
}

/// The file `binary` runs: itself when it is a path, else the first of
/// that name on `PATH`. A relative path is relative to `folder`, the
/// workspace folder the q tasks and terminals start in, not to the
/// extension host's working directory (#1132). Undefined when it is not a
/// program this user can run, a path as much as a name (#1691).
export function resolveBinary(binary: string, folder: string | undefined = workspace.workspaceFolders?.[0]?.uri.fsPath): string | undefined {
  const file = qBinaryFrom(binary, folder, os.homedir());
  if (file === undefined || path.isAbsolute(file)) {
    return file !== undefined && nodeFiles.executable(file) ? file : undefined;
  }
  const names = process.platform === "win32" && !/\.exe$/i.test(file) ? [file, `${file}.exe`] : [file];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    // A Windows entry may be quoted, as libuv reads it too (#1681).
    const dir = process.platform === "win32" ? entry.replace(/"/g, "") : entry;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (dir !== "" && nodeFiles.executable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const mtime = (file: string): number => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

export class Interpreters {
  private item: StatusBarItem | undefined;

  constructor(private readonly context: ExtensionContext) {
    context.subscriptions.push(
      commands.registerCommand(INTERPRETER_COMMANDS.select, () => this.select()),
      commands.registerCommand(INTERPRETER_COMMANDS.checkLicence, () => this.checkLicence()),
      window.onDidChangeActiveTextEditor(() => this.sync()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.interpreter") || event.affectsConfiguration("q-lint.terminal.qBinary")) {
          this.sync();
        }
        if (
          event.affectsConfiguration("q-lint.licence") ||
          event.affectsConfiguration("q-lint.terminal.qBinary") ||
          event.affectsConfiguration("q-lint.interpreter")
        ) {
          void this.warnFromKept();
        }
      }),
      { dispose: () => this.item?.dispose() },
    );
    this.sync();
    void this.warnFromKept();
  }

  /// The binary the workspace starts, as configured.
  private binary(): string {
    return readTerminal(get).qBinary;
  }

  private kept(): Record<string, Kept> {
    const value = this.context.globalState.get<Record<string, Kept>>(PROBES_KEY, {});
    return value !== null && typeof value === "object" ? value : {};
  }

  private async keep(file: string, found: Probe, env: Record<string, string>): Promise<Kept> {
    const licence = licenceFile(file, { ...process.env, ...env }, os.homedir(), nodeFiles);
    // Only what the probe printed: no banner text, no licensee.
    const kept: Kept = { ...found, ...(licence !== undefined ? { licence: { file: licence, mtime: mtime(licence) } } : {}) };
    await this.context.globalState.update(PROBES_KEY, { ...this.kept(), [file]: kept });
    return kept;
  }

  /// The status bar item, while the picker is on and a q editor is active.
  private sync(): void {
    const on = readInterpreter(get).enabled && window.activeTextEditor?.document.languageId === "q";
    if (!on) {
      this.item?.dispose();
      this.item = undefined;
      return;
    }
    if (this.item === undefined) {
      this.item = window.createStatusBarItem("q-lint.interpreter", StatusBarAlignment.Right, 100);
      this.item.name = "q Interpreter";
      this.item.command = INTERPRETER_COMMANDS.select;
    }
    const binary = this.binary();
    const file = resolveBinary(binary);
    const kept = file !== undefined ? this.kept()[file] : undefined;
    this.item.text = `$(terminal) ${iconsEscaped(kept !== undefined ? versionText(kept) : path.basename(binary))}`;
    this.item.tooltip = `q interpreter: ${file ?? `${binary} (not found)`}\nSelect q Interpreter`;
    this.item.show();
  }

  /// The status bar item's text, for tests and the e2e run.
  status(): string | undefined {
    return this.item?.text;
  }

  private refuse(what: string, setting: string): void {
    void window.showInformationMessage(plainMessage(`q-lint: ${what} is turned off. Set ${setting} to true to turn it on.`));
  }

  async select(): Promise<string | undefined> {
    if (!readInterpreter(get).enabled) {
      this.refuse("The q interpreter picker", "q-lint.interpreter.enable");
      return undefined;
    }
    // A binary in a workspace that is not trusted is not offered, since
    // listing one runs it to read its version (#1164).
    const folders =
      workspace.isTrusted === false ? [] : (workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).filter((f) => typeof f === "string");
    const found = discover({ env: process.env, home: os.homedir(), platform: process.platform, folders }, nodeFiles);
    const current = resolveBinary(this.binary());
    const dotenv = await dotenvFor(workspace.workspaceFolders?.[0]?.uri);
    type Item = QuickPickItem & { file?: string; enter?: true };
    const items = (async (): Promise<Item[]> => {
      const probed = await Promise.all(
        found.map(async (interpreter) => {
          const env = mergeEnv(layoutEnvFor(interpreter.path), dotenv);
          const answer = await probe(interpreter.path, env);
          if (answer !== undefined) {
            await this.keep(interpreter.path, answer, env);
          }
          return { interpreter, answer };
        }),
      );
      return [
        ...probed.map(({ interpreter, answer }): Item => ({
          label: `${interpreter.path === current ? "$(check) " : ""}${answer !== undefined ? versionText(answer) : "q (did not answer)"}`,
          description: interpreter.path,
          detail: interpreter.detail,
          file: interpreter.path,
        })),
        { label: "$(folder) Enter a q binary's path...", enter: true },
      ];
    })();
    const picked = await window.showQuickPick(items, { placeHolder: `Select the q this workspace starts (now ${current ?? this.binary()})`, matchOnDescription: true });
    if (picked === undefined) {
      return undefined;
    }
    let file = picked.file;
    if (picked.enter) {
      const typed = await window.showInputBox({ prompt: "The q binary to start: a path, where a leading ~ is your home directory.", ignoreFocusOut: true });
      if (typed === undefined || typed.trim() === "") {
        return undefined;
      }
      file = typed.trim();
      const resolved = resolveBinary(file);
      if (resolved === undefined || !nodeFiles.executable(resolved)) {
        void window.showErrorMessage(plainMessage(`q-lint: ${file} is not a program this user can run; the q interpreter was not changed.`));
        return undefined;
      }
    }
    if (file === undefined) {
      return undefined;
    }
    // Written where the value in force is set - a folder's own setting would
    // hide one written above it - else in the workspace, else for the user.
    const configuration = workspace.getConfiguration("q-lint", resource());
    const set = configuration.inspect<string>("terminal.qBinary");
    const target =
      set?.workspaceFolderValue !== undefined
        ? ConfigurationTarget.WorkspaceFolder
        : set?.workspaceValue !== undefined || (workspace.workspaceFolders ?? []).length > 0
          ? ConfigurationTarget.Workspace
          : ConfigurationTarget.Global;
    await configuration.update("terminal.qBinary", file, target);
    this.sync();
    return file;
  }

  /// Ask the configured binary for its licence's expiry date now, and say it.
  async checkLicence(): Promise<string | undefined> {
    const read = readInterpreter(get);
    if (!read.licence) {
      this.refuse("The q licence expiry warning", "q-lint.licence.expiryWarning.enable");
      return undefined;
    }
    const binary = this.binary();
    const file = resolveBinary(binary);
    if (file === undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: ${binary} was not found, so its licence could not be checked.`));
      return undefined;
    }
    const env = mergeEnv(layoutEnvFor(file), await dotenvFor(workspace.workspaceFolders?.[0]?.uri));
    const answer = await probe(file, env);
    if (answer === undefined) {
      void window.showWarningMessage(plainMessage(`q-lint: ${file} did not start and print its version, so its licence could not be checked.`));
      return undefined;
    }
    const kept = await this.keep(file, answer, env);
    this.sync();
    const days = kept.expiry !== undefined ? daysLeft(kept.expiry, new Date()) : undefined;
    if (kept.expiry === undefined || days === undefined) {
      const text = `q-lint: ${file} reports no licence expiry date (its .z.l is empty), so there is nothing to warn about.`;
      void window.showInformationMessage(plainMessage(text));
      return text;
    }
    const warning = expiryWarning(file, kept.expiry, days, read.warningDays);
    const text = warning ?? `q-lint: the q licence used by ${file} expires on ${kept.expiry}, in ${days} days.`;
    void (warning !== undefined ? window.showWarningMessage(plainMessage(text)) : window.showInformationMessage(plainMessage(text)));
    return text;
  }

  /// Warn of the configured binary's licence from what a probe kept, at most
  /// once a day for it. Nothing is started; a binary never probed, or whose
  /// licence file has changed since, is not warned of.
  async warnFromKept(today: Date = new Date()): Promise<string | undefined> {
    const read = readInterpreter(get);
    if (!read.licence) {
      return undefined;
    }
    const file = resolveBinary(this.binary());
    const kept = file !== undefined ? this.kept()[file] : undefined;
    if (file === undefined || kept?.expiry === undefined) {
      return undefined;
    }
    if (kept.licence !== undefined && mtime(kept.licence.file) !== kept.licence.mtime) {
      return undefined;
    }
    const days = daysLeft(kept.expiry, today);
    const warning = days !== undefined ? expiryWarning(file, kept.expiry, days, read.warningDays) : undefined;
    if (warning === undefined) {
      return undefined;
    }
    const day = today.toISOString().slice(0, 10);
    const warned = this.context.globalState.get<Record<string, string>>(WARNED_KEY, {});
    if (warned?.[file] === day) {
      return undefined;
    }
    await this.context.globalState.update(WARNED_KEY, { ...(warned ?? {}), [file]: day });
    void window.showWarningMessage(plainMessage(warning));
    return warning;
  }
}
