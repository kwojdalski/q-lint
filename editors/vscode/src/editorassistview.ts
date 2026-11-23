// Two editor features over the language server (`editorassist.ts` has the
// pure parts):
//
// The argument slot highlight (#997), on unless q-lint.argumentSlot.enable
// turns it off: as the cursor moves in a q editor, the server names the
// argument of a bracketed call it is in, and the slot is highlighted with
// the parameter's name drawn before it where no inlay hint already draws
// it. Only the language server is asked. Off, the listener and its
// decorations are disposed.
//
// Process names in workspace symbol search (#996), off unless
// q-lint.processSymbols.enable asks for it, since a search then asks the
// connected process: a second workspace symbol provider, beside the
// server's, lists the names the process defines and no workspace file does.
// They are read by the one fixed lambda `PROCESS_NAMES`, which changes
// nothing, through `borrowWhenFree` as the Process Explorer reads - so a
// busy process adds nothing - only while a search is typed, kept for a few
// seconds so each keystroke does not ask again. A production process is not
// asked. A name opens as a short read-only note on what it is.
import {
  EventEmitter,
  Location,
  MarkdownString,
  Position,
  Range,
  SymbolInformation,
  SymbolKind,
  ThemeColor,
  Uri,
  languages,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type TextEditor,
  type TextEditorDecorationType,
} from "vscode";
import { isProduction } from "./agent";
import {
  ARGUMENT_SLOT,
  DEFINED_IN_WORKSPACE,
  NAMES_LIMIT,
  PROCESS_NAMES,
  PROCESS_SYMBOL_SCHEME,
  matching,
  processSymbolDocument,
  readProcessNames,
  readSlot,
  slotHover,
  slotLabel,
  type ProcessName,
  type Slot,
} from "./editorassist";
import { editorFeatureOn, type Server } from "./editorfeatures";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";

const on = (feature: "argumentSlot" | "processSymbols"): boolean =>
  editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), feature);

/// How long the cursor rests before the slot is asked for.
const SETTLE = 80;
/// How long a process's names are kept between keystrokes of one search.
const KEEP = 5000;
/// How long a search waits for a query to finish before adding nothing.
const WAIT = 500;

/// Register the argument slot highlight while its setting is on.
export function registerArgumentSlot(
  context: ExtensionContext,
  server: () => Server | undefined,
): { registered: () => boolean; shown: () => { slot: Slot; label?: string } | undefined; update: (editor: TextEditor) => Promise<void> } {
  let running: SlotHighlight | undefined;
  const sync = (): void => {
    if (on("argumentSlot") && running === undefined) {
      running = new SlotHighlight(server);
    } else if (!on("argumentSlot") && running !== undefined) {
      running.dispose();
      running = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.argumentSlot") && sync()),
    { dispose: () => running?.dispose() },
  );
  return {
    registered: () => running !== undefined,
    shown: () => running?.shown,
    update: async (editor) => running?.update(editor),
  };
}

class SlotHighlight {
  private readonly slot: TextEditorDecorationType;
  private readonly label: TextEditorDecorationType;
  private readonly listeners: Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /// Bumped with each ask, so an answer to an older one is dropped.
  private asked = 0;
  shown: { slot: Slot; label?: string } | undefined;
  /// The editor the slot was last drawn in, cleared when another is
  /// updated: a decoration stays until its own editor is told (#1265).
  private drawnIn: TextEditor | undefined;

  constructor(private readonly server: () => Server | undefined) {
    this.slot = window.createTextEditorDecorationType({
      backgroundColor: new ThemeColor("editor.wordHighlightStrongBackground"),
      borderRadius: "2px",
    });
    this.label = window.createTextEditorDecorationType({});
    this.listeners = [
      window.onDidChangeTextEditorSelection((event) => this.soon(event.textEditor)),
      window.onDidChangeActiveTextEditor((editor) => (editor === undefined ? undefined : this.soon(editor))),
    ];
    if (window.activeTextEditor !== undefined) {
      this.soon(window.activeTextEditor);
    }
  }

  private soon(editor: TextEditor): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(editor), SETTLE);
  }

  private clear(editor: TextEditor): void {
    this.shown = undefined;
    editor.setDecorations(this.slot, []);
    editor.setDecorations(this.label, []);
  }

  async update(editor: TextEditor): Promise<void> {
    const asked = ++this.asked;
    if (this.drawnIn !== undefined && this.drawnIn !== editor) {
      this.clear(this.drawnIn);
    }
    this.drawnIn = editor;
    const document = editor.document;
    const lsp = this.server();
    if (document.languageId !== "q" || document.uri.scheme !== "file" || !editor.selection.isEmpty || lsp === undefined) {
      this.clear(editor);
      return;
    }
    const at = editor.selection.active;
    let slot: Slot | undefined;
    try {
      slot = readSlot(
        await lsp.sendRequest(ARGUMENT_SLOT, {
          textDocument: { uri: document.uri.toString() },
          position: { line: at.line, character: at.character },
        }),
      );
    } catch {
      slot = undefined;
    }
    if (asked !== this.asked) {
      return;
    }
    if (slot === undefined) {
      this.clear(editor);
      return;
    }
    const range = new Range(slot.range.start.line, slot.range.start.character, slot.range.end.line, slot.range.end.character);
    const label = slotLabel(slot);
    this.shown = { slot, ...(label !== undefined ? { label } : {}) };
    editor.setDecorations(this.slot, range.isEmpty ? [] : [{ range, hoverMessage: new MarkdownString().appendText(slotHover(slot)) }]);
    editor.setDecorations(
      this.label,
      label === undefined
        ? []
        : [
            {
              range: new Range(range.start, range.start),
              renderOptions: {
                before: {
                  contentText: label,
                  color: new ThemeColor("editorInlayHint.parameterForeground"),
                  backgroundColor: new ThemeColor("editor.wordHighlightStrongBackground"),
                  margin: "0 0.2em 0 0",
                  fontStyle: "italic",
                },
              },
            },
          ],
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.listeners.forEach((l) => l.dispose());
    this.slot.dispose();
    this.label.dispose();
    this.shown = undefined;
  }
}

/// Register the process names in workspace symbol search while its setting
/// is on, and the note a name opens as always (a note already open stays
/// readable).
export function registerProcessSymbols(
  context: ExtensionContext,
  live: Live,
  server: () => Server | undefined,
): { registered: () => boolean; search: (query: string) => Promise<SymbolInformation[]>; asked: () => number } {
  let provider: Disposable | undefined;
  const symbols = new ProcessSymbols(live, server);
  const sync = (): void => {
    if (on("processSymbols") && provider === undefined) {
      provider = languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: (query) => symbols.search(query) });
    } else if (!on("processSymbols") && provider !== undefined) {
      provider.dispose();
      provider = undefined;
      symbols.forget();
    }
  };
  sync();
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider(PROCESS_SYMBOL_SCHEME, symbols),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.processSymbols") && sync()),
    { dispose: () => provider?.dispose() },
  );
  return { registered: () => provider !== undefined, search: (query) => symbols.search(query), asked: () => symbols.asked };
}

class ProcessSymbols {
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;
  private kept: { process: string; at: number; names: ProcessName[] } | undefined;
  /// How many times the process was asked, for the tests.
  asked = 0;

  constructor(
    private readonly live: Live,
    private readonly server: () => Server | undefined,
  ) {}

  forget(): void {
    this.kept = undefined;
  }

  provideTextDocumentContent(uri: Uri): string {
    const query = new URLSearchParams(uri.query);
    return processSymbolDocument(uri.path.replace(/^\//, ""), query.get("kind") ?? "", query.get("process") ?? "");
  }

  private async names(): Promise<{ process: string; names: ProcessName[] } | undefined> {
    const process = this.live.activeProcess();
    if (process === undefined || isProduction(process)) {
      return undefined;
    }
    if (this.kept !== undefined && this.kept.process === process.label && Date.now() - this.kept.at < KEEP) {
      return this.kept;
    }
    this.asked += 1;
    const got = await borrowWhenFree(this.live, (connection) => connection.call(PROCESS_NAMES, NAMES_LIMIT), WAIT);
    if (got === undefined) {
      return undefined;
    }
    this.kept = { process: process.label, at: Date.now(), names: readProcessNames(got.value) };
    return this.kept;
  }

  async search(query: string): Promise<SymbolInformation[]> {
    if (!on("processSymbols")) {
      return [];
    }
    let found: { process: string; names: ProcessName[] } | undefined;
    try {
      found = await this.names();
    } catch {
      return [];
    }
    if (found === undefined) {
      return [];
    }
    const candidates = matching(found.names, query);
    const lsp = this.server();
    let defined: unknown[] = [];
    if (lsp !== undefined && candidates.length > 0) {
      try {
        const answer = await lsp.sendRequest(DEFINED_IN_WORKSPACE, { names: candidates.map((c) => c.name) });
        defined = Array.isArray(answer) ? answer : [];
      } catch {
        defined = [];
      }
    }
    const process = found.process;
    return candidates
      .filter((_, i) => defined[i] !== true)
      .map((c) => {
        const uri = Uri.from({ scheme: PROCESS_SYMBOL_SCHEME, path: `/${c.name}`, query: new URLSearchParams({ kind: c.kind, process }).toString() });
        const kind = c.kind === "function" ? SymbolKind.Function : c.kind === "table" ? SymbolKind.Struct : SymbolKind.Variable;
        return new SymbolInformation(c.name, kind, `${process} (process)`, new Location(uri, new Position(0, 0)));
      });
  }
}
