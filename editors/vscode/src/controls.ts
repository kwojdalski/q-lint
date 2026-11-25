// Query controls (#887): the unlimited and unwrapped toggles, a file's own
// connection, and Open q-lint Settings, as VS Code commands and status bar
// items. What they send and how they are kept is `querycontrols.ts`'s; the
// queries themselves are `live.ts`'s, which asks this class what to do.
import {
  commands,
  ConfigurationTarget,
  StatusBarAlignment,
  window,
  workspace,
  type ExtensionContext,
  type StatusBarItem,
  type TextDocument,
  type Uri,
} from "vscode";
import {
  CONTROL_COMMANDS,
  FILE_CONNECTIONS_KEY,
  bindingFor,
  bindingText,
  evaluationText,
  flagsText,
  readControls,
  savedFrom,
  withBinding,
  type ControlSettings,
  type UntitledBinding,
} from "./querycontrols";
import { isUriLike } from "./clicked";
import type { DirectMode } from "./qclient";

/// What the controls need of the live half.
export interface ControlsHost {
  activeLabel(): string | undefined;
  /// Whether, and why, the active process is evaluated directly (#2470).
  activeDirect?(): DirectMode | undefined;
  /// A process the user picks, by label; undefined if none was.
  pick(title: string): Promise<string | undefined>;
}

export class QueryControls {
  /// Unlimited is a toggle held for this window, as q-pro holds it: it stays
  /// on until turned off, and is off again after a reload, so a result sent
  /// whole is never a surprise left over from another day.
  private unlimitedOn = false;
  /// An untitled editor's process, kept for this window only: its name
  /// (`Untitled-1`) is the next window's first new editor's too, whose
  /// queries must not go where an editor closed unsaved was sent.
  private readonly untitled = new Map<string, string>();
  /// Bound untitled editors closed lately: one saved to a file is closed,
  /// and the file takes its process.
  private closed: UntitledBinding[] = [];
  /// When this window first saw each file open: one saved from an untitled
  /// editor has just opened, or is not seen yet (#1723).
  private readonly opened = new Map<string, number>();
  private readonly flags: StatusBarItem;
  private readonly fileItem: StatusBarItem;

  constructor(
    private readonly context: ExtensionContext,
    private readonly host: ControlsHost,
  ) {
    // Between the connection (50) and the query mode (49).
    this.flags = window.createStatusBarItem("q-lint.queryFlags", StatusBarAlignment.Left, 49.6);
    this.flags.name = "q-lint: query flags";
    this.fileItem = window.createStatusBarItem("q-lint.fileConnection", StatusBarAlignment.Left, 49.8);
    this.fileItem.name = "q-lint: file's q process";
    this.fileItem.command = CONTROL_COMMANDS.chooseFileConnection;
    // Open before this window looked: not just opened.
    for (const document of workspace.textDocuments ?? []) {
      this.opened.set(document.uri.toString(), 0);
    }
    const c = (name: string, run: (...args: never[]) => unknown) => commands.registerCommand(name, run);
    context.subscriptions.push(
      this.flags,
      this.fileItem,
      c(CONTROL_COMMANDS.toggleUnlimited, () => this.toggleUnlimited()),
      c(CONTROL_COMMANDS.toggleUnwrapped, () => this.toggleUnwrapped()),
      c(CONTROL_COMMANDS.chooseFileConnection, (label?: string, uri?: unknown) => this.chooseFileConnection(label, uri)),
      c(CONTROL_COMMANDS.clearFileConnection, () => this.clearFileConnection()),
      c(CONTROL_COMMANDS.openSettings, () =>
        commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
      ),
      window.onDidChangeActiveTextEditor(() => this.refresh()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.query.unwrapped")) {
          this.refresh();
        }
      }),
      // The next new editor in this window takes a closed one's name.
      workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === "untitled") {
          const label = this.untitled.get(document.uri.toString());
          if (label !== undefined) {
            this.closed = [...this.closed.filter((c) => Date.now() - c.at < 60_000), { label, text: document.getText(), at: Date.now() }];
          }
          this.untitled.delete(document.uri.toString());
        }
      }),
      workspace.onDidOpenTextDocument((document) => {
        if (!this.opened.has(document.uri.toString())) {
          this.opened.set(document.uri.toString(), Date.now());
        }
      }),
      // An untitled editor saved to a file keeps its process (#1529).
      workspace.onDidSaveTextDocument((document) => this.saved(document)),
      // A file renamed or moved, or one in a folder that was, keeps its process.
      workspace.onDidRenameFiles((event) => this.moved(event.files)),
    );
    this.refresh();
  }

  get unlimited(): boolean {
    return this.unlimitedOn;
  }

  settings(): ControlSettings {
    const configuration = workspace.getConfiguration("q-lint");
    return readControls((key, fallback) => configuration.get(key, fallback));
  }

  /// The process `uri` is bound to, if it is.
  binding(uri: Uri): string | undefined {
    if (uri.scheme === "untitled") {
      return this.untitled.get(uri.toString());
    }
    return bindingFor(this.context.workspaceState.get(FILE_CONNECTIONS_KEY), uri.toString());
  }

  /// Show the flags, and the active file's process when it is not the
  /// active connection. The live half calls it when the connection changes.
  refresh(): void {
    const unwrapped = this.settings().unwrapped;
    // Connected, the active process's own evaluation is shown (#2470); with
    // none, what the setting will do.
    const label = this.host.activeLabel();
    const direct = label === undefined ? undefined : this.host.activeDirect?.();
    const flags = flagsText(this.unlimitedOn, label === undefined && unwrapped, direct !== undefined);
    if (flags === "") {
      this.flags.hide();
    } else {
      this.flags.text = flags;
      this.flags.command = this.unlimitedOn
        ? CONTROL_COMMANDS.toggleUnlimited
        : direct?.from === "process"
          ? CONTROL_COMMANDS.setEvaluation
          : CONTROL_COMMANDS.toggleUnwrapped;
      this.flags.tooltip = [
        this.unlimitedOn ? "Unlimited query: console text is not cut at q-lint.output.consoleSize, and a grid or chart is sent every row." : "",
        direct !== undefined && label !== undefined
          ? evaluationText(label, direct, direct.from === "process")
          : label === undefined && unwrapped
            ? "Unwrapped query (q-lint.query.unwrapped): code is sent as a plain string, and the result formatted here."
            : "",
        this.unlimitedOn
          ? "Click to turn unlimited off."
          : direct?.from === "process"
            ? `Click to set the evaluation of ${label}.`
            : "Click to turn unwrapped off.",
      ].filter(Boolean).join("\n");
      this.flags.show();
    }
    const uri = window.activeTextEditor?.document.uri;
    const bound = uri === undefined ? undefined : this.binding(uri);
    const text = bindingText(bound, this.host.activeLabel());
    if (text === undefined) {
      this.fileItem.hide();
    } else {
      this.fileItem.text = text;
      this.fileItem.tooltip = `This file's queries go to ${bound}, which q-lint connects to when one is sent. Click to choose another.`;
      this.fileItem.show();
    }
  }

  private toggleUnlimited(): void {
    this.unlimitedOn = !this.unlimitedOn;
    this.refresh();
  }

  private async toggleUnwrapped(): Promise<void> {
    // Set where it is set already, so a workspace's choice is not shadowed.
    const configuration = workspace.getConfiguration("q-lint");
    const where = configuration.inspect("query.unwrapped");
    const target = where?.workspaceValue !== undefined ? ConfigurationTarget.Workspace : ConfigurationTarget.Global;
    await configuration.update("query.unwrapped", !this.settings().unwrapped, target);
    this.refresh();
  }

  /// Bind `uri` - an editor just opened, named so: two opened at once each
  /// bound the active one (#1530) - else the active editor's file.
  private async chooseFileConnection(label?: string, uri?: unknown): Promise<void> {
    const target = isUriLike(uri) ? (uri as Uri) : window.activeTextEditor?.document.uri;
    if (target === undefined) {
      void window.showInformationMessage("q-lint: open the file to choose its q process.");
      return;
    }
    const chosen = typeof label === "string" ? label : await this.host.pick("Send this file's queries to which q process?");
    if (chosen === undefined) {
      return;
    }
    await this.store(target, chosen);
  }

  private async clearFileConnection(): Promise<void> {
    const document = window.activeTextEditor?.document;
    if (document === undefined || this.binding(document.uri) === undefined) {
      void window.showInformationMessage("q-lint: this file has no q process of its own.");
      return;
    }
    await this.store(document.uri, undefined);
  }

  private async saved(document: TextDocument): Promise<void> {
    if (document.uri.scheme === "untitled" || this.binding(document.uri) !== undefined) {
      return;
    }
    const now = Date.now();
    const open = workspace.textDocuments.flatMap((d) => {
      const label = d.uri.scheme === "untitled" ? this.untitled.get(d.uri.toString()) : undefined;
      return label === undefined ? [] : [{ label, text: d.getText(), at: now }];
    });
    if (open.length === 0 && this.closed.length === 0) {
      return;
    }
    const label = savedFrom(document.getText(), [...open, ...this.closed], now, undefined, this.opened.get(document.uri.toString()));
    if (label !== undefined) {
      await this.store(document.uri, label);
    }
  }

  private async moved(files: readonly { oldUri: Uri; newUri: Uri }[]): Promise<void> {
    const stored = this.context.workspaceState.get(FILE_CONNECTIONS_KEY);
    let next = withBinding(stored, "", undefined);
    let changed = false;
    for (const { oldUri, newUri } of files) {
      const from = oldUri.toString();
      const to = newUri.toString();
      for (const [key, label] of Object.entries(next)) {
        if (key === from || key.startsWith(`${from}/`)) {
          next = withBinding(withBinding(next, key, undefined), to + key.slice(from.length), label);
          changed = true;
        }
      }
    }
    if (changed) {
      await this.context.workspaceState.update(FILE_CONNECTIONS_KEY, next);
      this.refresh();
    }
  }

  private async store(uri: Uri, label: string | undefined): Promise<void> {
    if (uri.scheme === "untitled") {
      if (label === undefined) {
        this.untitled.delete(uri.toString());
      } else {
        this.untitled.set(uri.toString(), label);
      }
      this.refresh();
      return;
    }
    const stored = this.context.workspaceState.get(FILE_CONNECTIONS_KEY);
    await this.context.workspaceState.update(FILE_CONNECTIONS_KEY, withBinding(stored, uri.toString(), label));
    this.refresh();
  }
}
