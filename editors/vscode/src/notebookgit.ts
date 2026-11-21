// q notebooks and git: Compare Notebook Cells (#998), a diff of two
// notebooks' cells that leaves outputs, run numbers and metadata out. The
// text each side shows is `qnbgit.ts`'s, the one `git diff` shows through
// its textconv; VS Code's diff editor compares the two.
import { execFile } from "node:child_process";
import * as path from "node:path";
import { EventEmitter, Uri, commands, window, workspace, type Disposable, type ExtensionContext, type TextDocumentContentProvider } from "vscode";
import { featureOn, qnbOf, requireFeature } from "./notebook";
import { NOTEBOOK } from "./qnb";
import { diffCells, diffSummary, notebookJson, notebookText, type CellLike } from "./qnbgit";

/// The scheme of the read-only documents a comparison shows.
export const CELLS_SCHEME = "q-lint-qnb-cells";
/// What the quick pick's first choice compares with.
export const HEAD = "HEAD";
/// How many comparisons' texts are kept for their documents.
const KEPT = 20;

/// `git show <ref>:<file>` from the file's folder: the file as committed.
/// Throws git's message when it cannot.
export function gitShow(file: string, ref: string = HEAD): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["show", `${ref}:./${path.basename(file)}`],
      { cwd: path.dirname(file), maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)),
    );
  });
}

/// The URI a command gets from a menu: a file's, or a Source Control
/// change's `resourceUri`.
function uriOf(arg: unknown): Uri | undefined {
  if (arg instanceof Uri) {
    return arg;
  }
  const resource = (arg as { resourceUri?: unknown } | undefined)?.resourceUri;
  return resource instanceof Uri ? resource : undefined;
}

export class NotebookDiff implements TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;
  private next = 0;
  /// The last comparison, for tests.
  last: { left: string; right: string; summary: string } | undefined;

  /// The provider's registration: only while the setting is on.
  private provider: Disposable | undefined;

  constructor(context: ExtensionContext) {
    this.follow();
    context.subscriptions.push(
      commands.registerCommand(NOTEBOOK.diffCommand, (source?: unknown, other?: Uri | string) => this.compare(source, other)),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.notebook.diff")) {
          this.follow();
        }
      }),
      this.changed,
      { dispose: () => this.provider?.dispose() },
    );
  }

  /// Whether the provider is registered: for tests.
  get registered(): boolean {
    return this.provider !== undefined;
  }

  /// Register the provider while the setting is on; off, dispose it and
  /// forget every comparison's text.
  private follow(): void {
    if (featureOn("diff") && this.provider === undefined) {
      this.provider = workspace.registerTextDocumentContentProvider(CELLS_SCHEME, this);
    } else if (!featureOn("diff") && this.provider !== undefined) {
      this.provider.dispose();
      this.provider = undefined;
      this.texts.clear();
    }
  }

  provideTextDocumentContent(uri: Uri): string {
    return this.texts.get(uri.query) ?? "This comparison is no longer open: run Compare Notebook Cells again.\n";
  }

  /// A read-only document holding `text`, named after `name`.
  private document(text: string, name: string): Uri {
    const id = String(++this.next);
    this.texts.set(id, text);
    while (this.texts.size > KEPT) {
      this.texts.delete(this.texts.keys().next().value as string);
    }
    return Uri.from({ scheme: CELLS_SCHEME, path: `/${name}`, query: id });
  }

  /// Compare the notebook `source` - the active one when not given - with
  /// `other`: a notebook file, `HEAD` (the file as last committed), or what
  /// the user picks.
  async compare(source?: unknown, other?: Uri | string): Promise<void> {
    if (!requireFeature("diff")) {
      return;
    }
    const active = window.activeNotebookEditor?.notebook;
    const from = uriOf(source) ?? (active?.notebookType === NOTEBOOK.type ? active.uri : undefined);
    if (from === undefined || (from.toString() !== active?.uri.toString() && !/\.qnb$/i.test(from.path))) {
      void window.showInformationMessage("q-lint: open a q notebook (.qnb) to compare its cells.");
      return;
    }
    let against = other;
    if (against === undefined) {
      const picked = await window.showQuickPick(
        [
          ...(from.scheme === "file" ? [{ label: "The last commit (HEAD)", detail: "The notebook as git last committed it", value: HEAD as Uri | string }] : []),
          { label: "Another q notebook...", detail: "A .qnb file you pick", value: "pick" },
        ],
        { title: `Compare the cells of ${path.posix.basename(from.path)} with` },
      );
      if (picked === undefined) {
        return;
      }
      against = picked.value;
      if (against === "pick") {
        const files = await window.showOpenDialog({ title: "Compare with which q notebook?", filters: { "q notebook": ["qnb"] }, canSelectMany: false });
        if (files === undefined || files.length === 0) {
          return;
        }
        against = files[0];
      }
    }
    const name = path.posix.basename(from.path);
    let right: CellLike[];
    let left: CellLike[];
    let leftName: string;
    try {
      right = (await qnbOf(from)).cells;
    } catch (error) {
      void window.showErrorMessage(`q-lint: could not read ${from.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      if (typeof against === "string") {
        if (from.scheme !== "file") {
          void window.showInformationMessage(`q-lint: ${name} is not a file in a git repository: save it first.`);
          return;
        }
        const committed = notebookJson(await gitShow(from.fsPath, against));
        if (committed === undefined) {
          throw new Error(`${name} at ${against} is not a q notebook`);
        }
        left = committed.cells;
        leftName = `${name} (${against})`;
      } else {
        left = (await qnbOf(against)).cells;
        leftName = path.posix.basename(against.path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void window.showErrorMessage(`q-lint: could not read the notebook to compare with: ${message}`);
      return;
    }
    const summary = diffSummary(diffCells(left, right));
    const leftText = notebookText(left);
    const rightText = notebookText(right);
    this.last = { left: leftText, right: rightText, summary };
    await commands.executeCommand(
      "vscode.diff",
      this.document(leftText, `${leftName}.cells`),
      this.document(rightText, `${name}.cells`),
      `${leftName} ↔ ${name} (cells)`,
    );
    void window.showInformationMessage(`q-lint: ${leftName} against ${name}: ${summary}. Outputs, run numbers and metadata are not compared.`);
  }
}

/// Register Compare Notebook Cells: its command, which says when the
/// setting is off, and its documents' provider, only while it is on.
export function registerNotebookGit(context: ExtensionContext): { diff: NotebookDiff } {
  return { diff: new NotebookDiff(context) };
}
