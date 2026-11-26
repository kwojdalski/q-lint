// Code cells and the Interactive Window (#956), the Run Cell, Run Above and
// Run Below lenses (#958) and Smart Send (#957). A cell's code goes through
// `runText` (`consolerun.ts`) - the file's bound process, the read-only
// guard, Query History - and its answer is drawn in the Interactive Window.
// Each feature's switch is read when it acts, and a lens provider or a
// listener of one turned off is disposed, so nothing is drawn or sent.
import {
  CodeLens,
  EventEmitter,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  commands,
  languages,
  window,
  workspace,
  type CodeLensProvider,
  type Disposable,
  type ExtensionContext,
  type TextDocument,
} from "vscode";
import { cellAt, cellCode, cellName, cells, looksLikeMarker, shownCode, smartStep, type Cell } from "./cells";
import { ConsolePanel, type ConsoleEntry } from "./consolepanel";
import { answerLines, runText } from "./consolerun";
import { HAS_CELLS, INTERACTIVE_COMMANDS, readInteractive, turnedOff, type InteractiveSettings } from "./interactiveconfig";
import type { Live } from "./live";
import { blockAt, contextAfter, scriptCode, selectionCode, statements } from "./statements";
import { plainMessage } from "./history";

const settings = (): InteractiveSettings => readInteractive((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback));

/// The REPL pane, as Smart Send's `repl` target sends to it.
export interface ReplSink {
  runFromEditor(code: string, uri: Uri): Promise<void>;
}

const CELLS_OFF = turnedOff("Code cells and the Interactive Window", "q-lint.cells.enable");
const LENSES_OFF = turnedOff("Run Above and Run Below (the cell code lenses)", "q-lint.cells.codeLens.enable");
const SMART_OFF = turnedOff("Smart Send", "q-lint.smartSend.enable");

/// The document a lens's command names by its URI, or the active editor's.
function documentOf(uri: unknown): TextDocument | undefined {
  if (typeof uri === "string" || uri instanceof Uri) {
    const name = uri.toString();
    return workspace.textDocuments.find((d) => d.uri.toString() === name);
  }
  return window.activeTextEditor?.document;
}

export function registerInteractive(
  context: ExtensionContext,
  live: Live,
  repl: ReplSink,
): {
  /// The Interactive Window's runs, oldest first.
  entries: () => ConsoleEntry[];
  isOpen: () => boolean;
  /// Whether the cell lens provider is registered.
  lensesRegistered: () => boolean;
  lenses: (document: TextDocument) => CodeLens[];
} {
  const panel = new ConsolePanel(context, { viewType: "q-lint.interactiveWindow", title: "q Interactive", input: false });
  /// Cell runs one at a time, in order: a second Run Cell waits for the first.
  let queue: Promise<unknown> = Promise.resolve();
  /// Smart Send's statements to the REPL, one at a time, in order (#2563).
  let replQueue: Promise<unknown> = Promise.resolve();

  /// Run `code` into the Interactive Window under `title`, in `context`:
  /// true when it ran and q gave no error.
  const runInto = async (code: string, uri: Uri, title?: string, context = "."): Promise<boolean> => {
    // A cell queued before cells were turned off is not sent (#1277).
    if (!settings().cells) {
      return false;
    }
    if (statements(code).length === 0) {
      return true;
    }
    panel.open();
    const id = panel.add({ ...(title !== undefined ? { title } : {}), code });
    const ran = await runText(live, code, uri, context);
    if (ran === undefined) {
      panel.remove(id);
      return false;
    }
    panel.update(id, { process: ran.process, millis: ran.millis, ok: ran.answer.ok, lines: answerLines(ran) });
    return ran.answer.ok;
  };

  /// Run `chosen` of the cells of `document` in order, stopping at the
  /// first that fails, as Jupyter's Run Above does.
  const runCells = (document: TextDocument, choose: (all: Cell[]) => Cell[]): Promise<void> => {
    const lines = document.getText().split(/\r?\n/);
    const all = cells(lines);
    const chosen = choose(all);
    const run = queue.then(async () => {
      for (const cell of chosen) {
        // In the `\d` the file leaves above it, as loading the file runs it
        // (#2286), and without the indented lines q skips above the first
        // statement (#2278).
        const context = contextAfter(scriptCode(lines.slice(0, cell.start).join("\n")));
        if (!(await runInto(shownCode(scriptCode(cellCode(lines, cell)), cell), document.uri, cellName(all, cell), context))) {
          return;
        }
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  /// The document and line a cell command acts on: the lens's, or the
  /// active editor's cursor. Says why there is none.
  const target = (uri: unknown, line: unknown): { document: TextDocument; line: number } | undefined => {
    const document = documentOf(uri);
    if (document === undefined) {
      void window.showInformationMessage("q-lint: open a q file first: there is no active editor.");
      return undefined;
    }
    const at = typeof line === "number" ? line : window.activeTextEditor?.selection.active.line ?? 0;
    return { document, line: at };
  };

  /// Why no cell is at the line: the file has none, or it has, and the line
  /// is among the comments above the first (#1938).
  const noCells = (all: Cell[] = []): void =>
    void window.showInformationMessage(
      plainMessage(
        all.length > 0
          ? "q-lint: the cursor is above the file's first cell. Put it in a cell: on its `/ %%` line or under it."
          : "q-lint: the file has no cells. A line starting `/ %%` at column 0 starts one.",
      ),
    );

  const runCell = (uri?: unknown, line?: unknown): Promise<void> | undefined => {
    if (!settings().cells) {
      void window.showInformationMessage(CELLS_OFF);
      return undefined;
    }
    const t = target(uri, line);
    if (t === undefined) {
      return undefined;
    }
    const all = cells(t.document.getText().split(/\r?\n/));
    const cell = cellAt(all, t.line);
    if (cell === undefined) {
      noCells(all);
      return undefined;
    }
    return runCells(t.document, () => [cell]);
  };

  const runAll = (uri?: unknown): Promise<void> | undefined => {
    if (!settings().cells) {
      void window.showInformationMessage(CELLS_OFF);
      return undefined;
    }
    const t = target(uri, 0);
    if (t === undefined) {
      return undefined;
    }
    if (cells(t.document.getText().split(/\r?\n/)).length === 0) {
      noCells();
      return undefined;
    }
    return runCells(t.document, (all) => all);
  };

  /// Run Above: the cells before the one at `line`. Run Below: that one
  /// and those after it.
  const runAround = (above: boolean, uri?: unknown, line?: unknown): Promise<void> | undefined => {
    const s = settings();
    if (!s.cells || !s.cellLenses) {
      void window.showInformationMessage(plainMessage(s.cells ? LENSES_OFF : CELLS_OFF));
      return undefined;
    }
    const t = target(uri, line);
    if (t === undefined) {
      return undefined;
    }
    const all = cells(t.document.getText().split(/\r?\n/));
    const cell = cellAt(all, t.line);
    if (cell === undefined) {
      noCells(all);
      return undefined;
    }
    const at = all.indexOf(cell);
    return runCells(t.document, () => (above ? all.slice(0, at) : all.slice(at)));
  };

  const lenses = (document: TextDocument): CodeLens[] => {
    const s = settings();
    if (!s.cells || !s.cellLenses) {
      return [];
    }
    const all = cells(document.getText().split(/\r?\n/));
    const uri = document.uri.toString();
    return all.flatMap((cell, i) => {
      if (cell.marker === undefined) {
        return [];
      }
      const range = new Range(cell.marker, 0, cell.marker, 0);
      const name = cellName(all, cell);
      return [
        new CodeLens(range, { title: "Run Cell", command: INTERACTIVE_COMMANDS.runCell, arguments: [uri, cell.marker], tooltip: `Run ${name} in the Interactive Window` }),
        ...(i > 0
          ? [new CodeLens(range, { title: "Run Above", command: INTERACTIVE_COMMANDS.runAbove, arguments: [uri, cell.marker], tooltip: `Run the cells above ${name}` })]
          : []),
        new CodeLens(range, { title: "Run Below", command: INTERACTIVE_COMMANDS.runBelow, arguments: [uri, cell.marker], tooltip: `Run ${name} and the cells below it` }),
      ];
    });
  };

  // The lens provider, while both switches are on.
  const lensesChanged = new EventEmitter<void>();
  let lensProvider: Disposable | undefined;
  const provider: CodeLensProvider = { onDidChangeCodeLenses: lensesChanged.event, provideCodeLenses: (document) => lenses(document) };

  // Ctrl+Enter's context: whether the active q editor has a cell. A line
  // that reads as a marker is the cheap test; inside a block comment or
  // after the script's end it starts none, and `cells` says so (#1938).
  let hasCells = false;
  const setHasCells = (): void => {
    const document = window.activeTextEditor?.document;
    const lines = settings().cells && document?.languageId === "q" ? document.getText().split(/\r?\n/) : [];
    const now = lines.some(looksLikeMarker) && cells(lines).length > 0;
    if (now !== hasCells) {
      hasCells = now;
      void commands.executeCommand("setContext", HAS_CELLS, now);
    }
  };
  let cellListeners: Disposable[] = [];

  const sync = (): void => {
    const s = settings();
    if (s.cells && s.cellLenses && lensProvider === undefined) {
      lensProvider = languages.registerCodeLensProvider({ language: "q" }, provider);
    } else if (!(s.cells && s.cellLenses) && lensProvider !== undefined) {
      lensProvider.dispose();
      lensProvider = undefined;
    }
    lensesChanged.fire();
    if (s.cells && cellListeners.length === 0) {
      cellListeners = [
        window.onDidChangeActiveTextEditor(() => setHasCells()),
        workspace.onDidChangeTextDocument((event) => event.document === window.activeTextEditor?.document && setHasCells()),
      ];
    } else if (!s.cells) {
      for (const l of cellListeners) {
        l.dispose();
      }
      cellListeners = [];
      // Turned off, the window and what it showed go.
      panel.dispose();
    }
    setHasCells();
  };

  /// Smart Send: the selection, or the statement at the cursor, to the
  /// target the setting names; then the cursor moves to the next statement.
  const smartSend = async (): Promise<void> => {
    const s = settings();
    if (!s.smartSend) {
      void window.showInformationMessage(SMART_OFF);
      return;
    }
    const editor = window.activeTextEditor;
    if (editor === undefined) {
      void window.showInformationMessage("q-lint: open a q file first: there is no active editor.");
      return;
    }
    const document = editor.document;
    let code: string | undefined;
    if (!editor.selection.isEmpty) {
      // Read as q reads the file there (#2287).
      code = selectionCode(document.getText().split("\n"), editor.selection.start.line, document.getText(editor.selection));
    } else {
      const lines = document.getText().split(/\r?\n/);
      const step = smartStep(lines, editor.selection.active.line, blockAt);
      if (step.send !== undefined) {
        code = lines.slice(step.send.start, step.send.end + 1).join("\n");
      }
      const to = new Selection(step.next, 0, step.next, 0);
      editor.selection = to;
      editor.revealRange(new Range(step.next, 0, step.next, 0), TextEditorRevealType.Default);
    }
    if (code === undefined || statements(code).length === 0) {
      return;
    }
    switch (s.smartSendTarget) {
      case "interactiveWindow":
        if (!s.cells) {
          void window.showInformationMessage(CELLS_OFF);
          return;
        }
        {
          // Queued as Run Cell is: the cursor has moved past it already, so
          // a second Shift+Enter while one runs waits, not refused (#2563).
          const sent = code;
          const run = queue.then(() => runInto(sent, document.uri));
          queue = run.catch(() => {});
          await run;
        }
        return;
      case "repl": {
        const sent = code;
        const run = replQueue.then(() => repl.runFromEditor(sent, document.uri));
        replQueue = run.catch(() => {});
        await run;
        return;
      }
      case "terminal":
        await live.sendToTerminal(code, document.uri);
        return;
      default:
        await live.queryFilledIn(code, document.uri);
    }
  };

  const c = commands.registerCommand;
  context.subscriptions.push(
    c(INTERACTIVE_COMMANDS.runCell, (uri?: unknown, line?: unknown) => runCell(uri, line)),
    c(INTERACTIVE_COMMANDS.runAllCells, (uri?: unknown) => runAll(uri)),
    c(INTERACTIVE_COMMANDS.runAbove, (uri?: unknown, line?: unknown) => runAround(true, uri, line)),
    c(INTERACTIVE_COMMANDS.runBelow, (uri?: unknown, line?: unknown) => runAround(false, uri, line)),
    c(INTERACTIVE_COMMANDS.openInteractive, () => (settings().cells ? panel.open(true) : void window.showInformationMessage(CELLS_OFF))),
    c(INTERACTIVE_COMMANDS.clearInteractive, () => (settings().cells ? panel.clear() : void window.showInformationMessage(CELLS_OFF))),
    c(INTERACTIVE_COMMANDS.smartSend, () => smartSend()),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("q-lint.cells")) {
        sync();
      }
    }),
    lensesChanged,
    {
      dispose: () => {
        lensProvider?.dispose();
        for (const l of cellListeners) {
          l.dispose();
        }
        panel.dispose();
      },
    },
  );
  sync();
  return { entries: () => panel.entries(), isOpen: () => panel.isOpen, lensesRegistered: () => lensProvider !== undefined, lenses };
}
