// A function's source from the process (#929) and its callers there (#935):
// the VS Code around `funcsource.ts`.
//
// Open Function Source shows a function as the process has it, in a
// read-only editor (a `q-lint-source:` document, which VS Code never lets
// one type into). Edit and Redefine copies it into a new q editor, and
// Redefine on Process sends that back - once the user has confirmed, with
// the production warning for a process tagged prod - and only to the
// process it came from, and only while the process still has the text it
// was copied from. Find Callers lists the functions that call a name; one
// picked opens at the call. Each half has its own setting
// (`insightconfig.ts`): turned off, its commands refuse and send nothing.
import {
  EventEmitter,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type TextDocument,
  type TextDocumentContentProvider,
} from "vscode";
import { readExplorer, charKinds, type Node } from "./explorer";
import {
  CALLERS,
  CALLER_NAMESPACES,
  REDEFINE,
  SOURCE,
  editable,
  editedText,
  firstUse,
  nameAt,
  nameFromPath,
  readCallers,
  readSource,
  redefineConfirmation,
  sourceDocument,
  sourcePath,
  SOURCE_COMMANDS,
  type Source,
} from "./funcsource";
import { borrowWhenFree } from "./infoview";
import { readInsight, turnedOff, type InsightFeature } from "./insightconfig";
import type { Live } from "./live";
import { guardedBy, readGuard } from "./guard";
import type { Process } from "./processes";
import { plainMessage } from "./history";

export const SCHEME = "q-lint-source";
/// Set while the active editor holds a copy Redefine can send.
const REDEFINABLE = "q-lint.redefinable";

/// A function as Open Function Source last read it.
interface Shown {
  process: string;
  name: string;
  source: Source;
}

/// An editable copy: where it goes, and the text the process had when it
/// was copied, which Redefine checks is still there.
interface Copy {
  process: string;
  name: string;
  was: string;
  /// The read-only document it was copied from, to show the new text.
  from: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/// Ask before replacing `name` - one function, or several as a sentence
/// lists them - on `process`, in a modal with the production warning: the
/// one place Redefine on Process and hot reload on save (#934) ask. `yes`
/// are the buttons that send; `also` is said after the detail. The button
/// picked, or undefined.
export async function askRedefine(name: string, process: Process, yes: string[] = ["Redefine"], also?: string): Promise<string | undefined> {
  // The read-only guard (#918) is named when it guards the process: a
  // redefinition always assigns.
  const asked = redefineConfirmation(name, process, guardedBy(process, readGuard((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback))));
  const detail = also === undefined ? asked.detail : `${asked.detail} ${also}`;
  // A modal VS Code refuses to show (as in its test host) is a No.
  return Promise.resolve(window.showWarningMessage(plainMessage(asked.message), { modal: true, detail }, ...yes)).catch(() => undefined);
}

/// Whether `feature` is on; when it is not, says so.
function on(feature: InsightFeature): boolean {
  const configuration = workspace.getConfiguration("q-lint");
  if (readInsight((key, fallback) => configuration.get(key, fallback))[feature]) {
    return true;
  }
  void window.showInformationMessage(plainMessage(turnedOff(feature)));
  return false;
}

export class FunctionSources implements TextDocumentContentProvider {
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;
  private readonly shown = new Map<string, Shown>();
  private readonly copies = new Map<string, Copy>();

  constructor(context: ExtensionContext, private readonly live: Live) {
    context.subscriptions.push(
      this.changed,
      workspace.registerTextDocumentContentProvider(SCHEME, this),
      commands.registerCommand(SOURCE_COMMANDS.open, (arg?: Node | string) => (on("functionSource") ? this.open(arg) : undefined)),
      commands.registerCommand(SOURCE_COMMANDS.edit, (uri?: Uri) => (on("functionSource") ? this.edit(uri) : undefined)),
      commands.registerCommand(SOURCE_COMMANDS.redefine, () => (on("functionSource") ? this.redefine() : false)),
      commands.registerCommand(SOURCE_COMMANDS.callers, (arg?: Node | string) => (on("findCallers") ? this.callers(arg) : undefined)),
      window.onDidChangeActiveTextEditor((editor) => this.setRedefinable(editor?.document)),
      workspace.onDidCloseTextDocument((document) => {
        this.copies.delete(document.uri.toString());
        if (document.uri.scheme === SCHEME) {
          this.shown.delete(document.uri.toString());
        }
      }),
    );
  }

  /// The URI a function's source is shown under: its name as the path, so
  /// the tab is titled by it, and the process as the query.
  static uri(process: string, name: string): Uri {
    return Uri.from({ scheme: SCHEME, path: sourcePath(name), query: process });
  }

  provideTextDocumentContent(uri: Uri): string {
    const shown = this.shown.get(uri.toString());
    // Read before the document is opened, and again by Redefine.
    return shown === undefined
      ? `/ ${nameFromPath(uri.path)}: not read from ${uri.query}; open it again from the Process Explorer.\n`
      : sourceDocument(shown.name, shown.process, shown.source);
  }

  /// The function a command was asked about: an explorer row's, a name
  /// passed, the name under the cursor in a q editor, or one typed.
  private async target(arg: Node | string | undefined, verb: string): Promise<string | undefined> {
    if (typeof arg === "string" && arg !== "") {
      return arg;
    }
    if (arg !== undefined && typeof arg === "object" && arg.name !== undefined) {
      return arg.name;
    }
    const editor = window.activeTextEditor;
    if (editor !== undefined && editor.document.languageId === "q") {
      const at = editor.selection.active;
      const found = editor.selection.isEmpty
        ? nameAt(editor.document.lineAt(at.line).text, at.character)
        : editor.document.getText(editor.selection).trim();
      if (found) {
        return found;
      }
    }
    return window.showInputBox({ title: `q-lint: ${verb}`, prompt: "A function's name, as q code names it: f or .ns.f" });
  }

  private async read(name: string): Promise<Shown | undefined> {
    if (this.live.activeLabel() === undefined) {
      void window.showInformationMessage("q-lint: connect to a q process to read its functions.");
      return undefined;
    }
    try {
      const got = await borrowWhenFree(this.live, async (connection, process) => ({
        process: process.label,
        name,
        source: readSource(await connection.call(SOURCE, name)),
      }));
      if (got === undefined) {
        void window.showInformationMessage(plainMessage(`q-lint: ${this.live.activeLabel()} is busy with a query; try again when it is done.`));
      }
      return got?.value;
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not read ${name} from ${this.live.activeLabel() ?? "the process"}: ${message(error)}`));
      return undefined;
    }
  }

  /// Open Function Source: read the function, and show it read-only. Undefined
  /// when nothing was shown.
  async open(arg?: Node | string, at?: (text: string) => number): Promise<Uri | undefined> {
    const name = await this.target(arg, "Open Function Source");
    if (name === undefined) {
      return undefined;
    }
    const shown = await this.read(name);
    if (shown === undefined) {
      return undefined;
    }
    const uri = FunctionSources.uri(shown.process, name);
    this.shown.set(uri.toString(), shown);
    this.changed.fire(uri);
    const document = await workspace.openTextDocument(uri);
    const editor = await window.showTextDocument(document, { preview: true });
    const offset = at?.(document.getText()) ?? -1;
    if (offset >= 0) {
      const position = document.positionAt(offset);
      editor.selection = new Selection(position, position);
      editor.revealRange(new Range(position, position), TextEditorRevealType.InCenterIfOutsideViewport);
    }
    return uri;
  }

  /// Edit and Redefine: copy the source shown in `uri` (or the active
  /// editor) into a new q editor that Redefine on Process sends back.
  async edit(uri?: Uri): Promise<TextDocument | undefined> {
    const key = (uri ?? window.activeTextEditor?.document.uri)?.toString();
    const shown = key === undefined ? undefined : this.shown.get(key);
    if (shown === undefined || key === undefined) {
      void window.showInformationMessage("q-lint: Edit and Redefine copies a function opened by Open Function Source.");
      return undefined;
    }
    if (!editable(shown.source)) {
      void window.showInformationMessage(plainMessage(`q-lint: ${shown.name} is not a lambda, so it has no text to edit.`));
      return undefined;
    }
    const document = await workspace.openTextDocument({ language: "q", content: sourceDocument(shown.name, shown.process, shown.source) });
    this.copies.set(document.uri.toString(), { process: shown.process, name: shown.name, was: shown.source.text, from: key });
    await window.showTextDocument(document);
    this.setRedefinable(document);
    return document;
  }

  private setRedefinable(document: TextDocument | undefined): void {
    void commands.executeCommand("setContext", REDEFINABLE, document !== undefined && this.copies.has(document.uri.toString()));
  }

  /// Redefine on Process: send the active copy back to its process, after
  /// asking. False when it was not sent or was refused.
  async redefine(): Promise<boolean> {
    const document = window.activeTextEditor?.document;
    const copy = document === undefined ? undefined : this.copies.get(document.uri.toString());
    if (document === undefined || copy === undefined) {
      void window.showInformationMessage("q-lint: Redefine on Process sends a copy made by Edit and Redefine.");
      return false;
    }
    const process = this.live.activeProcess();
    if (process === undefined || process.label !== copy.process) {
      void window.showInformationMessage(
        plainMessage(`q-lint: ${copy.name} was copied from ${copy.process}; connect to it to redefine it there${process === undefined ? "" : ` (connected to ${process.label})`}.`),
      );
      return false;
    }
    const text = editedText(document.getText());
    if ((await askRedefine(copy.name, process)) !== "Redefine") {
      return false;
    }
    // Turned off at the question: nothing is sent (#1453).
    if (!on("functionSource")) {
      return false;
    }
    try {
      // Only on the process the question named (#1290).
      const got = await borrowWhenFree(this.live, (connection) => connection.call(REDEFINE, copy.name, copy.was, text), undefined, copy.process);
      if (got === undefined) {
        void window.showInformationMessage(plainMessage(`q-lint: ${copy.process} is busy with a query; ${copy.name} was not redefined.`));
        return false;
      }
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: ${copy.name} was not redefined on ${copy.process}: ${message(error)}`));
      return false;
    }
    copy.was = text;
    const shown = this.shown.get(copy.from);
    if (shown !== undefined) {
      shown.source = { ...shown.source, text };
      this.changed.fire(Uri.parse(copy.from));
    }
    void window.showInformationMessage(plainMessage(`q-lint: redefined ${copy.name} on ${copy.process}.`));
    return true;
  }

  /// Find Callers: the loaded functions that call `arg`, to pick one and
  /// open it at the call.
  async callers(arg?: Node | string): Promise<void> {
    const name = await this.target(arg, "Find Callers in Process");
    if (name === undefined) {
      return;
    }
    if (this.live.activeLabel() === undefined) {
      void window.showInformationMessage("q-lint: connect to a q process to find what calls a name there.");
      return;
    }
    const configuration = workspace.getConfiguration("q-lint");
    const { excludedNamespaces } = readExplorer((key, fallback) => configuration.get(key, fallback));
    let found;
    try {
      found = await borrowWhenFree(this.live, async (connection, process) => ({
        process: process.label,
        callers: readCallers(await connection.call(CALLERS, excludedNamespaces.join(" "), name, CALLER_NAMESPACES)),
      }));
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not read the callers of ${name}: ${message(error)}`));
      return;
    }
    if (found === undefined) {
      void window.showInformationMessage(plainMessage(`q-lint: ${this.live.activeLabel()} is busy with a query; try again when it is done.`));
      return;
    }
    const { process, callers } = found.value;
    const unread = callers.more > 0 ? ` (${callers.more} namespaces not read)` : "";
    if (callers.callers.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: no function on ${process} calls ${name}, of ${callers.scanned} read${unread}.`));
      return;
    }
    const picked = await window.showQuickPick(
      callers.callers.map((c) => ({
        label: c.name,
        description: `[${c.params.join(";")}]`,
        detail: c.how === "calls" ? `calls ${name}` : `names ${name} by symbol`,
        caller: c,
      })),
      { title: `Callers of ${name} on ${process}: ${callers.callers.length} of ${callers.scanned} functions${unread}`, matchOnDescription: true },
    );
    if (picked !== undefined) {
      await this.open(picked.caller.name, (text) => firstUse(text, name, charKinds(text)));
    }
  }

  /// The source documents and editable copies open now, for tests.
  state(): { shown: string[]; copies: Copy[] } {
    return { shown: [...this.shown.keys()], copies: [...this.copies.values()] };
  }
}
