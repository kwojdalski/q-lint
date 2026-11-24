// q notebooks and git: Compare Notebook Cells (#998), a diff of two
// notebooks' cells that leaves outputs, run numbers and metadata out. The
// text each side shows is `qnbgit.ts`'s, the one `git diff` shows through
// its textconv; VS Code's diff editor compares the two.
//
// Outputs on commit (#999), as nbstripout does it: Clear Notebook Outputs
// strips the `.qnb` files picked, and Set Up Git to Strip Notebook Outputs
// installs `qnbgit.js --strip` as a git clean filter for `*.qnb` in one
// repository. Nothing is written into git until the user has seen what will
// be written and said yes; a filter already set is never changed, and no
// hook is written at all.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter, Uri, commands, window, workspace, type Disposable, type ExtensionContext, type TextDocumentContentProvider } from "vscode";
import { featureOn, qnbOf, requireFeature } from "./notebook";
import { NOTEBOOK } from "./qnb";
import { diffCells, diffSummary, hasOutputs, notebookJson, notebookText, stripQnb, type CellLike } from "./qnbgit";
import { plainMessage } from "./history";
import { onProcessPath } from "./relations";

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
    // Found on PATH, not in the notebook's folder as Windows would (#1407).
    const git = onProcessPath("git");
    if (git === undefined) {
      reject(new Error("git is not on PATH"));
      return;
    }
    execFile(
      git,
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
      commands.registerCommand(NOTEBOOK.diffCommand, (source?: unknown, other?: unknown) => this.compare(source, other)),
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
  async compare(source?: unknown, other?: unknown): Promise<void> {
    if (!requireFeature("diff")) {
      return;
    }
    const active = window.activeNotebookEditor?.notebook;
    const from = uriOf(source) ?? (active?.notebookType === NOTEBOOK.type ? active.uri : undefined);
    if (from === undefined || (from.toString() !== active?.uri.toString() && !/\.qnb$/i.test(from.path))) {
      void window.showInformationMessage("q-lint: open a q notebook (.qnb) to compare its cells.");
      return;
    }
    // From the Explorer, the second argument is the selection, not a
    // notebook: anything but a Uri or HEAD is asked for (#1336).
    let against = other instanceof Uri || other === HEAD ? other : undefined;
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
      void window.showErrorMessage(plainMessage(`q-lint: could not read ${from.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    try {
      if (typeof against === "string") {
        if (workspace.isTrusted === false) {
          void window.showInformationMessage("q-lint: comparing with git asks git for the committed notebook, which is not done in a workspace that is not trusted.");
          return;
        }
        if (from.scheme !== "file") {
          void window.showInformationMessage(plainMessage(`q-lint: ${name} is not a file in a git repository: save it first.`));
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
      void window.showErrorMessage(plainMessage(`q-lint: could not read the notebook to compare with: ${message}`));
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
    void window.showInformationMessage(plainMessage(`q-lint: ${leftName} against ${name}: ${summary}. Outputs, run numbers and metadata are not compared.`));
  }
}

/// The git filter's name, as `.gitattributes` and `git config` spell it.
export const FILTER = "qnb-strip";
/// The line that sends `*.qnb` through it.
export const ATTRIBUTE_LINE = `*.qnb filter=${FILTER}`;
const HAS_ATTRIBUTE = new RegExp(`^\\*\\.qnb\\s(.*\\s)?filter=${FILTER}(\\s|$)`, "m");

/// Where the attribute goes: this clone's `.git/info/attributes`, or the
/// repository's `.gitattributes`, committed for everyone who clones it.
export type AttributesAt = "info" | "gitattributes";

/// Run git in `cwd`: its exit code and output.
function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const binary = onProcessPath("git");
    if (binary === undefined) {
      resolve({ code: -1, stdout: "", stderr: "git is not on PATH" });
      return;
    }
    execFile(binary, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
      resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
    });
  });
}

/// Whether `node` runs from PATH, as git will run the filter.
function nodeOnPath(): Promise<boolean> {
  const node = onProcessPath("node");
  return node === undefined ? Promise.resolve(false) : new Promise((resolve) => execFile(node, ["--version"], (error) => resolve(error === null)));
}

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/// What Set Up Git to Strip Notebook Outputs found and would write.
export interface FilterPlan {
  top: string;
  /// The copy of `qnbgit.js` the filter runs, in the repository's git folder.
  script: string;
  scriptAction: "write" | "replace" | "keep";
  /// The `filter.qnb-strip.clean` command, and whether it is set already.
  clean: string;
  cleanSet: boolean;
  attributes: string;
  attributeSet: boolean;
  node: boolean;
}

export class NotebookStrip {
  /// The last setup's plan, for tests.
  lastPlan: FilterPlan | undefined;

  constructor(
    context: ExtensionContext,
    /// The `qnbgit.js` the filter's copy is made from: this extension's.
    private readonly source: string = path.join(__dirname, "qnbgit.js"),
  ) {
    context.subscriptions.push(
      commands.registerCommand(NOTEBOOK.stripCommand, (uri?: Uri, uris?: Uri[]) => this.strip(uri, uris)),
      commands.registerCommand(NOTEBOOK.stripFilterCommand, (folder?: Uri, where?: AttributesAt) => this.setUp(folder, where)),
    );
  }

  /// Ask `message` in a modal dialog, with `detail` under it: whether the
  /// user chose `button`. A method, so a run without dialogs - the e2e
  /// harness - can answer in their place.
  async ask(message: string, detail: string, button: string): Promise<boolean> {
    return (await window.showWarningMessage(plainMessage(message), { modal: true, detail }, button)) === button;
  }

  /// Clear the outputs, run numbers and live values of the `.qnb` files
  /// picked in the explorer - or the active notebook's file - once the user
  /// says yes. A notebook open with unsaved edits is left alone.
  async strip(uri?: Uri, uris?: Uri[]): Promise<void> {
    if (!requireFeature("stripOutputs")) {
      return;
    }
    const active = window.activeNotebookEditor?.notebook;
    const picked = uris !== undefined && uris.length > 0 ? uris : uri instanceof Uri ? [uri] : active?.notebookType === NOTEBOOK.type ? [active.uri] : [];
    const files = picked.filter((u) => /\.qnb$/i.test(u.path) && u.scheme === "file");
    if (files.length === 0) {
      void window.showInformationMessage("q-lint: pick a saved q notebook (.qnb) to clear its outputs.");
      return;
    }
    const unsaved = files.filter((u) => workspace.notebookDocuments.some((n) => n.uri.toString() === u.toString() && n.isDirty));
    const todo: { uri: Uri; text: string }[] = [];
    let clean = 0;
    for (const file of files.filter((u) => !unsaved.includes(u))) {
      let text: string;
      try {
        text = Buffer.from(await workspace.fs.readFile(file)).toString("utf8");
      } catch (error) {
        void window.showErrorMessage(plainMessage(`q-lint: could not read ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (hasOutputs(text)) {
        todo.push({ uri: file, text });
      } else {
        clean++;
      }
    }
    const names = (list: Uri[]): string => list.map((u) => path.basename(u.fsPath)).join(", ");
    const unsavedNote = unsaved.length > 0 ? ` ${names(unsaved)} ${unsaved.length === 1 ? "has" : "have"} unsaved edits: save first.` : "";
    if (todo.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: no outputs to clear.${unsavedNote}`));
      return;
    }
    const go = "Clear Outputs";
    const confirmed = await this.ask(
      `Clear the outputs of ${names(todo.map((t) => t.uri))}?`,
      "Each cell's outputs, run number and times, and the live values of Markdown cells, are removed from the file. The cells are kept.",
      go,
    );
    if (!confirmed) {
      return;
    }
    for (const { uri: file, text } of todo) {
      try {
        await workspace.fs.writeFile(file, Buffer.from(stripQnb(text), "utf8"));
      } catch (error) {
        void window.showErrorMessage(plainMessage(`q-lint: could not write ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
    }
    void window.showInformationMessage(
      plainMessage(`q-lint: cleared the outputs of ${todo.length} ${todo.length === 1 ? "notebook" : "notebooks"}${clean > 0 ? `; ${clean} had none` : ""}.${unsavedNote}`),
    );
  }

  /// What setting up the filter in the repository around `folder` would
  /// write, or why it cannot be set up there.
  async plan(folder: string, where: AttributesAt): Promise<FilterPlan | { error: string }> {
    const top = await git(["rev-parse", "--show-toplevel"], folder);
    // The repository's common directory and the attributes file git reads:
    // in a linked worktree, those of the main one - the filter set with
    // --local is shared, so its script must outlive the worktree (#1270).
    const dir = await git(["rev-parse", "--git-common-dir"], folder);
    const info = await git(["rev-parse", "--git-path", "info/attributes"], folder);
    if (top.code !== 0 || dir.code !== 0 || info.code !== 0) {
      return { error: `${folder} is not in a git repository (${(top.stderr || dir.stderr || info.stderr).trim()}).` };
    }
    const root = top.stdout.trim();
    const gitDir = path.resolve(folder, dir.stdout.trim());
    const script = path.join(gitDir, "q-lint", "qnbgit.js");
    const ours = readText(this.source);
    if (ours === undefined) {
      return { error: `this extension's ${this.source} is missing.` };
    }
    const theirs = readText(script);
    // Forward slashes: git runs the command through a POSIX shell.
    const clean = `node "${script.replace(/\\/g, "/")}" --strip`;
    const set = await git(["config", "--local", "--get", `filter.${FILTER}.clean`], root);
    const current = set.code === 0 ? set.stdout.trim() : undefined;
    if (current !== undefined && current !== clean) {
      return {
        error: `filter.${FILTER}.clean is set already, to ${current}, and q-lint does not change it. To have q-lint set it, remove it first: git config --unset filter.${FILTER}.clean`,
      };
    }
    const attributes = where === "info" ? path.resolve(folder, info.stdout.trim()) : path.join(root, ".gitattributes");
    return {
      top: root,
      script,
      scriptAction: theirs === undefined ? "write" : theirs === ours ? "keep" : "replace",
      clean,
      cleanSet: current !== undefined,
      attributes,
      attributeSet: HAS_ATTRIBUTE.test(readText(attributes) ?? ""),
      node: await nodeOnPath(),
    };
  }

  /// Set Up Git to Strip Notebook Outputs: in the repository of `folder` -
  /// the active notebook's or the first workspace folder's when not given -
  /// show what would be written, and write it once the user says yes.
  async setUp(folder?: Uri, where?: AttributesAt): Promise<void> {
    if (!requireFeature("stripOutputs")) {
      return;
    }
    if (workspace.isTrusted === false) {
      void window.showInformationMessage("q-lint: setting up the git filter runs git, which is not done in a workspace that is not trusted.");
      return;
    }
    const active = window.activeNotebookEditor?.notebook.uri;
    const from = folder instanceof Uri
      ? folder.fsPath
      : active?.scheme === "file" ? path.dirname(active.fsPath) : workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (from === undefined) {
      void window.showInformationMessage("q-lint: open a folder in a git repository to set up its filter.");
      return;
    }
    let at = where;
    if (at === undefined) {
      const picked = await window.showQuickPick(
        [
          { label: ".git/info/attributes", detail: "This clone only: nothing to commit", at: "info" as AttributesAt },
          { label: ".gitattributes", detail: "Committed, for everyone who clones the repository (each sets the filter up for themselves)", at: "gitattributes" as AttributesAt },
        ],
        { title: "Where should git read that *.qnb files go through the filter?" },
      );
      if (picked === undefined) {
        return;
      }
      at = picked.at;
    }
    const plan = await this.plan(from, at);
    if ("error" in plan) {
      void window.showErrorMessage(plainMessage(`q-lint: ${plan.error}`));
      return;
    }
    this.lastPlan = plan;
    const steps: string[] = [];
    if (plan.scriptAction !== "keep") {
      steps.push(`${plan.scriptAction === "write" ? "Write" : "Replace, since it differs from this extension's,"} ${plan.script}: the filter, a copy of this extension's qnbgit.js.`);
    }
    if (!plan.cleanSet) {
      steps.push(`Run: git config --local filter.${FILTER}.clean '${plan.clean}'`);
    }
    if (!plan.attributeSet) {
      steps.push(`Add the line "${ATTRIBUTE_LINE}" at the end of ${plan.attributes}.`);
    }
    if (steps.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: ${plan.top} strips notebook outputs on commit already.`));
      return;
    }
    const warning = plan.node ? "" : "\n\nnode was not found on PATH. Until it is, git cannot run the filter, and commits notebooks as they are.";
    const go = "Write";
    const confirmed = await this.ask(
      `Set up git in ${plan.top} to strip q notebook outputs on commit?`,
      `${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nNo hook is written, and nothing else is changed.${warning}`,
      go,
    );
    if (!confirmed) {
      return;
    }
    try {
      if (plan.scriptAction !== "keep") {
        fs.mkdirSync(path.dirname(plan.script), { recursive: true });
        fs.copyFileSync(this.source, plan.script);
      }
      if (!plan.cleanSet) {
        const set = await git(["config", "--local", `filter.${FILTER}.clean`, plan.clean], plan.top);
        if (set.code !== 0) {
          throw new Error(set.stderr.trim());
        }
      }
      if (!plan.attributeSet) {
        const before = readText(plan.attributes) ?? "";
        fs.mkdirSync(path.dirname(plan.attributes), { recursive: true });
        fs.appendFileSync(plan.attributes, `${before === "" || before.endsWith("\n") ? "" : "\n"}${ATTRIBUTE_LINE}\n`);
      }
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not set up the filter: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    void window.showInformationMessage(
      plainMessage(`q-lint: git in ${plan.top} now commits q notebooks without their outputs; the files keep them. A notebook committed before keeps its outputs in git until it is next committed.`),
    );
  }
}

/// Register Compare Notebook Cells - its command, which says when the
/// setting is off, and its documents' provider, only while it is on - and
/// Clear Notebook Outputs and Set Up Git to Strip Notebook Outputs.
export function registerNotebookGit(context: ExtensionContext): { diff: NotebookDiff; strip: NotebookStrip } {
  return { diff: new NotebookDiff(context), strip: new NotebookStrip(context) };
}
