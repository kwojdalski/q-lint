// The q REPL pane (#959): a console beside the editor whose input runs on
// the connected process. Enter runs a complete statement and starts a new
// line inside an open bracket or string; Up and Down walk the history,
// Ctrl+R searches it, and Tab completes a name from q's words, the
// language server's workspace symbols and the process's own names. What
// is typed goes through `runText` (`consolerun.ts`), so the read-only
// guard asks before a write to a guarded process and it lands in Query
// History. The process's names are read with the Process Explorer's
// read-only lambda, and only when Tab asks for them.
import { commands, window, workspace, type ExtensionContext, type SymbolInformation, type Uri } from "vscode";
import { ConsolePanel, type ConsoleEntry, type PageMessage } from "./consolepanel";
import { answerLines, runText } from "./consolerun";
import { GATHER, LIMITS, fullName, readExplorer, readGathered } from "./explorer";
import { INTERACTIVE_COMMANDS, readInteractive, turnedOff } from "./interactiveconfig";
import type { Live } from "./live";
import { RESERVED } from "./qliteral";
import { completionsFor, isComplete, pushHistory, replScript, searchHistory, wordAt, type Completion } from "./repl";

const HISTORY_KEY = "q-lint.replHistory";
const REPL_OFF = turnedOff("The q REPL pane", "q-lint.repl.enable");
const on = (): boolean => readInteractive((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).repl;

export function registerRepl(
  context: ExtensionContext,
  live: Live,
): {
  entries: () => ConsoleEntry[];
  isOpen: () => boolean;
  history: () => string[];
  /// What the page's Enter does with `code`: runs it when complete, else
  /// answers "newline". For tests, as the page sends it.
  enter: (code: string) => Promise<"ran" | "newline" | "refused">;
  complete: (text: string, caret: number) => Promise<{ start: number; caret: number; items: Completion[] }>;
  search: (query: string, from: number) => { index: number; code: string };
  /// Smart Send's `repl` target (#957).
  runFromEditor: (code: string, uri: Uri) => Promise<void>;
} {
  /// Read when first needed, newest first.
  let kept: string[] | undefined;
  const past = (): string[] => (kept ??= context.globalState.get<string[]>(HISTORY_KEY, []));
  /// The process's names as last read, and the process they are of: read
  /// again after each run, since a run can define names.
  let names: { process: string; labels: string[] } | undefined;
  let running = false;

  const panel: ConsolePanel = new ConsolePanel(context, {
    viewType: "q-lint.replPane",
    title: "q REPL",
    input: true,
    initial: () => ({ history: past() }),
    onMessage: (message: PageMessage) => void handle(message),
  });

  /// Run `code`, from the pane's input or the editor (`uri`), and draw it.
  const run = async (code: string, uri?: Uri): Promise<boolean> => {
    if (running) {
      void window.showInformationMessage("q-lint: the q REPL is still running the last input.");
      return false;
    }
    running = true;
    try {
      kept = pushHistory(past(), code);
      await context.globalState.update(HISTORY_KEY, kept);
      panel.post({ type: "accepted", history: kept });
      const id = panel.add({ code });
      const ran = await runText(live, replScript(code), uri);
      names = undefined;
      if (ran === undefined) {
        panel.update(id, { ok: false, lines: ["Not run."] });
        return false;
      }
      panel.update(id, { process: ran.process, millis: ran.millis, ok: ran.answer.ok, lines: answerLines(ran) });
      return true;
    } finally {
      running = false;
    }
  };

  const enter = async (code: string): Promise<"ran" | "newline" | "refused"> => {
    if (!on()) {
      void window.showInformationMessage(REPL_OFF);
      return "refused";
    }
    if (code.trim() !== "" && !isComplete(code)) {
      panel.post({ type: "newline" });
      return "newline";
    }
    if (code.trim() === "") {
      return "ran";
    }
    await run(code);
    return "ran";
  };

  /// The process's names, read once until the next run; none while a query
  /// is running or nothing is connected.
  const processNames = async (): Promise<Completion[]> => {
    const label = live.activeLabel();
    if (label === undefined) {
      return [];
    }
    if (names === undefined || names.process !== label) {
      const { excludedNamespaces } = readExplorer((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback));
      const call = live.borrow(async (connection, process) => ({
        process: process.label,
        labels: readGathered(await connection.call(GATHER, excludedNamespaces.join(" "), LIMITS)).entries.map(fullName),
      }));
      names = call === undefined ? undefined : await call.catch(() => undefined);
    }
    return (names?.labels ?? []).map((n) => ({ label: n, detail: names?.process ?? "" }));
  };

  const complete = async (text: string, caret: number): Promise<{ start: number; caret: number; items: Completion[] }> => {
    const word = wordAt(text, caret);
    if (word === undefined || !on()) {
      return { start: caret, caret, items: [] };
    }
    const symbols = await Promise.resolve(
      commands.executeCommand<SymbolInformation[] | undefined>("vscode.executeWorkspaceSymbolProvider", word.prefix),
    ).catch(() => undefined);
    const fromServer = (Array.isArray(symbols) ? symbols : []).map((s) => ({ label: s.name, detail: "workspace" }));
    const words = [...RESERVED].map((w) => ({ label: w, detail: "q" }));
    const items = completionsFor(word.prefix, [...(await processNames()), ...fromServer, ...words]);
    return { start: word.start, caret, items };
  };

  const search = (query: string, from: number): { index: number; code: string } => {
    const index = searchHistory(past(), query, from);
    return { index, code: index >= 0 ? past()[index] : "" };
  };

  const handle = async (message: PageMessage): Promise<void> => {
    if (message.type === "enter" && typeof message.code === "string") {
      await enter(message.code);
    } else if (message.type === "complete" && typeof message.text === "string" && typeof message.caret === "number") {
      panel.post({ type: "completions", ...(await complete(message.text, message.caret)) });
    } else if (message.type === "search" && typeof message.query === "string") {
      panel.post({ type: "found", ...search(message.query, typeof message.from === "number" ? message.from : 0) });
    }
  };

  const open = (): void => {
    if (!on()) {
      void window.showInformationMessage(REPL_OFF);
      return;
    }
    panel.open(true);
    panel.post({ type: "focus" });
  };

  const runFromEditor = async (code: string, uri: Uri): Promise<void> => {
    if (!on()) {
      void window.showInformationMessage(REPL_OFF);
      return;
    }
    panel.open();
    await run(code, uri);
  };

  context.subscriptions.push(
    commands.registerCommand(INTERACTIVE_COMMANDS.openRepl, () => open()),
    workspace.onDidChangeConfiguration((event) => {
      // Turned off, the pane closes; its history is kept.
      if (event.affectsConfiguration("q-lint.repl") && !on()) {
        panel.dispose();
        names = undefined;
      }
    }),
    { dispose: () => panel.dispose() },
  );
  return { entries: () => panel.entries(), isOpen: () => panel.isOpen, history: () => past(), enter, complete, search, runFromEditor };
}
