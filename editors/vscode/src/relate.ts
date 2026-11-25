// How the workspace's q files relate, in the editor: a view of the files the
// active q file depends on and of those depending on it, and a list of the
// tests that reach what changed against git HEAD.
//
// Both are the server's answers - `q-lint/graph` and `q-lint/affectedTests` -
// shown; what they mean, and the rows and lines made of them, is in
// `relations.ts`, which needs no editor and is tested. The one thing decided
// here is which files changed: the server starts no process, so this asks git
// and sends what it says. Nothing here runs a test or any q: a row opens a
// file, and that is all it does.
//
// Call hierarchy needs nothing from this file. The server announces it and
// the language client registers it, like the rest of the protocol.
import {
  commands,
  window,
  workspace,
  EventEmitter,
  ProgressLocation,
  Range,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  type ExtensionContext,
  type TextDocument,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import type { LanguageClient } from "vscode-languageclient/node";
import {
  AFFECTED_TESTS,
  AVAILABLE,
  COMMANDS,
  GRAPH,
  VIEW,
  announces,
  asAffectedTests,
  asGraph,
  changedFiles,
  gitCommand,
  isQ,
  onPath,
  picks,
  rows,
  summary,
  unsavedIn,
  type Git,
  type Row,
} from "./relations";
import { plainMessage } from "./history";

/// How long the view waits after the last reason to refresh before asking.
/// The server draws the whole workspace's graph for each request - a quarter
/// of a second over a few thousand files - and answers one request at a
/// time, so a burst of saves or a run through several tabs asks once.
const SETTLE_MS = 200;

/// How long git has to answer. A git that has not listed what changed by
/// now is waiting on something - a lock, a network drive, a prompt nobody
/// sees - and is stopped, so the command ends by saying so instead of never.
const GIT_TIMEOUT_MS = 30_000;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/// A file as the view and the list name it: relative to its workspace folder.
function name(uri: string): string {
  return workspace.asRelativePath(Uri.parse(uri));
}

/// A document the server reads: a `.q` file on disk, as the client's
/// document selector has it.
function isQFile(document: TextDocument): boolean {
  return document.uri.scheme === "file" && isQ(document.uri.fsPath);
}

/// Runs `binary` as git. No shell: the arguments are passed as they are, so
/// no file name can be read as a command. `binary` is a path or, off
/// Windows, a name for `PATH` (`onPath`). `GIT_OPTIONAL_LOCKS=0` keeps a
/// read from taking the index lock a commit in a terminal may be waiting on.
function git(binary: string): Git {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout, stderr) => {
          if (error?.killed && typeof error.code !== "string") {
            reject(new Error(`git ${args[0]} gave no answer in ${GIT_TIMEOUT_MS / 1000} s.`));
          } else if (error) {
            reject(new Error(stderr.trim() || error.message));
          } else {
            resolve(stdout);
          }
        },
      );
    });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Relations implements TreeDataProvider<Row> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: TreeView<Row>;
  /// The q file the view is of: the last one that was the active editor.
  /// Kept when focus moves to something that is not a q file - a terminal,
  /// the Output panel, a diff - so the view does not empty under a reader.
  private shown: Uri | undefined;
  private top: Row[] = [];
  /// Counts the requests made, so an answer that a later request has
  /// overtaken is dropped instead of drawn over the newer one.
  private asked = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /// Set while the affected tests are being listed: the command asked for
  /// again before it answers would start git again beside the first.
  private listing = false;
  /// Set when the extension is deactivated. The server is stopped after
  /// that, and says so here; there is no view left to redraw by then.
  private disposed = false;

  /// `client` is the running language client, or undefined between two of
  /// them: `extension.ts` replaces it on every restart.
  constructor(
    context: ExtensionContext,
    private readonly client: () => LanguageClient | undefined,
  ) {
    this.view = window.createTreeView(VIEW, { treeDataProvider: this });
    this.track(window.activeTextEditor?.document);
    context.subscriptions.push(
      this.view,
      this.changed,
      {
        dispose: () => {
          this.disposed = true;
          clearTimeout(this.timer);
        },
      },
      window.onDidChangeActiveTextEditor((editor) => {
        if (this.track(editor?.document)) {
          this.refresh();
        }
      }),
      // Any q file's save, not only the shown one's: another file that
      // starts reading a name this one defines becomes a dependent of it.
      workspace.onDidSaveTextDocument((document) => {
        if (isQFile(document)) {
          this.refresh();
        }
      }),
      this.view.onDidChangeVisibility((event) => {
        if (event.visible) {
          this.refresh();
        }
      }),
      commands.registerCommand(COMMANDS.show, () => this.show()),
      commands.registerCommand(COMMANDS.refresh, () => this.refresh()),
      commands.registerCommand(COMMANDS.affectedTests, () => this.affectedTests()),
    );
  }

  /// Tell the view the server was started, restarted or stopped: whether it
  /// has a graph to show is the new server's to say.
  serverChanged(): void {
    if (this.disposed) {
      return;
    }
    void commands.executeCommand("setContext", AVAILABLE, this.has(GRAPH));
    this.refresh();
  }

  getTreeItem(row: Row): TreeItem {
    const item = new TreeItem(
      row.label,
      row.children ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None,
    );
    item.description = row.description;
    item.tooltip = row.tooltip;
    if (row.uri !== undefined) {
      const uri = Uri.parse(row.uri);
      const at = row.line === undefined ? undefined : new Range(row.line - 1, 0, row.line - 1, 0);
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [uri, at ? { selection: at } : {}],
      };
      if (row.line === undefined) {
        item.resourceUri = uri;
        item.iconPath = ThemeIcon.File;
      }
    }
    return item;
  }

  getChildren(row?: Row): Row[] {
    return row ? (row.children ?? []) : this.top;
  }

  /// Whether the running server announced `method`.
  private has(method: string): boolean {
    const client = this.client();
    return (
      client !== undefined &&
      client.isRunning() &&
      announces(client.initializeResult?.capabilities, method)
    );
  }

  /// Make `document` the one the view is of, if it is a q file. Whether it
  /// was.
  private track(document: TextDocument | undefined): boolean {
    if (document === undefined || !isQFile(document)) {
      return false;
    }
    this.shown = document.uri;
    return true;
  }

  private refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), SETTLE_MS);
  }

  private async load(): Promise<void> {
    // A view nobody is looking at asks nothing; it is asked for again when
    // it is shown.
    if (!this.view.visible) {
      return;
    }
    const asked = ++this.asked;
    const client = this.client();
    const shown = this.shown;
    let top: Row[] = [];
    let message: string | undefined;
    if (client === undefined || !this.has(GRAPH)) {
      message = "The q-lint server is not running, or q-lint.graph.enable is off.";
    } else if (shown === undefined) {
      message = "Open a q file to see the files it depends on and the files depending on it.";
    } else {
      const uri = client.code2ProtocolConverter.asUri(shown);
      try {
        const graph = asGraph(await client.sendRequest(GRAPH, { textDocument: { uri } }));
        if (graph === undefined) {
          message = "q-lint has not indexed this file, so it has no graph for it.";
        } else {
          top = rows(graph, name);
        }
      } catch (error) {
        message = `q-lint could not read the graph: ${reason(error)}`;
      }
    }
    if (asked !== this.asked) {
      return;
    }
    this.top = top;
    this.view.description = shown === undefined ? undefined : name(shown.toString());
    this.view.message = message;
    this.changed.fire();
  }

  private async show(): Promise<void> {
    if (!this.has(GRAPH)) {
      void window.showWarningMessage(
        plainMessage("q-lint: no dependencies to show. The server is not running, is older than this " +
          "extension, or q-lint.graph.enable is off."),
      );
      return;
    }
    this.track(window.activeTextEditor?.document);
    // The command VS Code makes for every contributed view.
    await commands.executeCommand(`${VIEW}.focus`);
    this.refresh();
  }

  /// List the test files that reach a q file changed against git HEAD, and
  /// open the one chosen. It lists; running them is the user's tooling's.
  private async affectedTests(): Promise<void> {
    if (this.listing) {
      void window.showInformationMessage("q-lint: the affected tests are already being listed.");
      return;
    }
    this.listing = true;
    try {
      await this.listAffectedTests();
    } finally {
      this.listing = false;
    }
  }

  private async listAffectedTests(): Promise<void> {
    const client = this.client();
    if (client === undefined || !this.has(AFFECTED_TESTS)) {
      void window.showWarningMessage(
        plainMessage("q-lint: cannot list affected tests. The server is not running, is older than this " +
          "extension, or q-lint.graph.enable is off."),
      );
      return;
    }
    // Git reads the repository's own configuration, which can name programs
    // for it to run. VS Code's git support stays off in a workspace that is
    // not trusted for that reason, and so does this.
    if (!workspace.isTrusted) {
      void window.showWarningMessage(
        plainMessage("q-lint: listing affected tests asks git which files changed, which is not done in " +
          "a workspace that is not trusted."),
      );
      return;
    }
    const folders = (workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
    if (folders.length === 0) {
      void window.showInformationMessage(
        "q-lint: open a folder to list the tests its changes reach.",
      );
      return;
    }
    const named = gitCommand();
    const binary = onPath(named, process.env.PATH, isFile);
    if (binary === undefined) {
      void window.showWarningMessage(
        plainMessage(`q-lint: could not ask git which files changed: ${named} is not on PATH.`),
      );
      return;
    }
    const run = git(binary);
    const paths = new Set<string>();
    const failed: string[] = [];
    const answered: string[] = [];
    await window.withProgress(
      { location: ProgressLocation.Window, title: "q-lint: asking git what changed" },
      async () => {
        for (const folder of folders) {
          try {
            for (const path of await changedFiles(run, folder.uri.fsPath)) {
              paths.add(path);
            }
            answered.push(folder.uri.fsPath);
          } catch (error) {
            failed.push(`${folder.name}: ${reason(error)}`);
          }
        }
      },
    );
    if (failed.length === folders.length) {
      void window.showWarningMessage(
        plainMessage(`q-lint: could not ask git which files changed. ${failed.join(" ")}`),
      );
      return;
    }
    // A buffer edited and not saved differs from HEAD too, and the server's
    // graph is already of the buffer: leaving it out would list the tests of
    // a file as it was, beside an editor showing it as it is. Only in a
    // folder git answered for: elsewhere a file has no HEAD to differ from.
    const dirty = workspace.textDocuments.filter((d) => d.isDirty && isQFile(d)).map((d) => d.uri.fsPath);
    for (const path of unsavedIn(dirty, answered)) {
      paths.add(path);
    }
    const changed = [...paths]
      .filter(isQ)
      .map((path) => client.code2ProtocolConverter.asUri(Uri.file(path)));
    const skipped = failed.length === 0 ? "" : ` Not asked of git: ${failed.join(" ")}`;
    if (changed.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: no q file differs from git HEAD.${skipped}`));
      return;
    }
    let answer;
    try {
      answer = asAffectedTests(
        await window.withProgress(
          { location: ProgressLocation.Window, title: "q-lint: finding affected tests" },
          () => client.sendRequest(AFFECTED_TESTS, { changed }),
        ),
      );
    } catch (error) {
      void window.showWarningMessage(plainMessage(`q-lint: could not list affected tests: ${reason(error)}`));
      return;
    }
    if (answer === undefined) {
      void window.showWarningMessage("q-lint: the server had no answer about affected tests.");
      return;
    }
    const said = summary(answer) + skipped;
    const lines = picks(answer, name);
    if (lines.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: ${said}`));
      return;
    }
    const chosen = await window.showQuickPick(lines, {
      title: "q-lint: affected tests",
      placeHolder: said,
      matchOnDescription: true,
    });
    if (chosen !== undefined) {
      await window.showTextDocument(Uri.parse(chosen.uri));
    }
  }
}
