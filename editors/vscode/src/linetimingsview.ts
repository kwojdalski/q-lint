// Line timings (#986) in the editor: **q-lint: Time Lines on Process** runs
// the selection, or the whole file when nothing is selected, one statement at
// a time on the connected process, and draws each statement's time and
// memory after its last line (`linetimings.ts` has the q and what is
// measured). Only a run the user starts sends anything, through
// `Live.runOnActive`, so the read-only guard asks before code that would
// change a guarded process, as a query's would. Editing the document clears
// its timings, since the lines they belong to have moved; so does
// **q-lint: Clear Line Timings**. Off (q-lint.query.lineTimings.enable), the
// decorations are disposed, nothing listens, and the commands refuse.
import {
  MarkdownString,
  Range,
  ThemeColor,
  commands,
  window,
  workspace,
  type DecorationOptions,
  type ExtensionContext,
  type TextEditor,
  type TextEditorDecorationType,
} from "vscode";
import type { Live } from "./live";
import { scriptCode, selectionCode } from "./statements";
import { bytesText, lineTimingsLambda, decorationText, durationText, readTimings, statementSpans, summary, type Timings } from "./linetimings";
import { TOOLING_COMMANDS, toolingOff, toolingOn } from "./toolingfeatures";
import { plainMessage } from "./history";

export const TIME_LINES = TOOLING_COMMANDS.timeLines;
export const CLEAR_LINE_TIMINGS = TOOLING_COMMANDS.clearLineTimings;

const on = (): boolean => toolingOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "lineTimings");

/// Register the commands always, and the decorations while the setting is on.
export function registerLineTimings(
  context: ExtensionContext,
  live: Live,
): { registered: () => boolean; time: (editor?: TextEditor) => Promise<Timings | string>; shown: () => Map<string, Timings> } {
  let drawn: Drawn | undefined;
  const sync = (): void => {
    if (on() && drawn === undefined) {
      drawn = new Drawn();
    } else if (!on() && drawn !== undefined) {
      drawn.dispose();
      drawn = undefined;
    }
  };
  sync();
  const time = async (given?: TextEditor): Promise<Timings | string> => {
    if (!on() || drawn === undefined) {
      const off = toolingOff("lineTimings");
      void window.showInformationMessage(plainMessage(off));
      return off;
    }
    const editor = given ?? window.activeTextEditor;
    if (editor === undefined) {
      return say("q-lint: open a q file first: there is no active editor.");
    }
    const selection = editor.selection;
    const whole = selection.isEmpty;
    const first = whole ? 0 : selection.start.line;
    // A selection that ends at the start of a line does not take that line.
    const last = !whole && selection.end.character === 0 && selection.end.line > first ? selection.end.line - 1 : selection.end.line;
    // Read as q reads the file, and a selection as it reads there (#2287).
    const all = editor.document.getText();
    const written = whole ? scriptCode(all) : selectionCode(all.split("\n"), first, editor.document.getText(new Range(first, 0, last, Number.MAX_SAFE_INTEGER)));
    // Its `{{placeholders}}` asked for, as Run Query asks for them (#2445).
    const text = await live.filledIn(written);
    if (text === undefined) {
      return "nothing was run";
    }
    const spans = statementSpans(text, first);
    if (spans.length === 0) {
      return say(`q-lint: ${whole ? "the file" : "the selection"} has no statement to time.`);
    }
    const code = spans.map((s) => s.text).join("\n");
    const version = editor.document.version;
    // Timed on the file's own process (#2440).
    if (!(await live.toFileBinding(editor.document.uri))) {
      return "nothing was run";
    }
    // Timed inside q-lint's lambda, it would time the gateway (#2589).
    const refused = live.gatewayRefusal("Time Lines on Process", code);
    if (refused !== undefined) {
      return say(refused);
    }
    let ran: { process: string; value: unknown } | undefined;
    try {
      ran = await live.runOnActive(code, async (connection) => {
        const raw = await connection.guarded(lineTimingsLambda, spans.map((s) => s.text));
        // A statement `reval` refused is asked about, as a query's is.
        const failed = readTimings(raw, spans).timings.find((t) => !t.ok);
        if (failed?.error !== undefined) {
          connection.noteRefusal(failed.error);
        }
        return raw;
      }, "ask", undefined, undefined, true);
    } catch (error) {
      return say(`q-lint: line timings failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (ran === undefined) {
      return "nothing was run";
    }
    let result: Timings;
    try {
      result = readTimings(ran.value, spans);
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Edited while it ran, the lines have moved: nothing is drawn (#1119).
    if (editor.document.version !== version) {
      return say("q-lint: the file changed while its lines were timed; time them again.");
    }
    // Turned off while it ran: nothing is drawn.
    drawn?.show(editor, result);
    void window.showInformationMessage(plainMessage(`q-lint: ${summary(result, ran.process)}`));
    return result;
  };
  context.subscriptions.push(
    commands.registerCommand(TIME_LINES, () => time()),
    commands.registerCommand(CLEAR_LINE_TIMINGS, () => {
      if (!on() || drawn === undefined) {
        void window.showInformationMessage(plainMessage(toolingOff("lineTimings")));
        return;
      }
      drawn.clear();
    }),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.query.lineTimings") && sync()),
    { dispose: () => drawn?.dispose() },
  );
  return { registered: () => drawn !== undefined, time, shown: () => drawn?.results ?? new Map() };
}

function say(message: string): string {
  void window.showInformationMessage(plainMessage(message));
  return message;
}

/// The decorations, one type for every editor, and what each document shows.
class Drawn {
  readonly results = new Map<string, Timings>();
  /// Made at the first run, with the listeners: turning the feature on
  /// draws and listens to nothing yet.
  private type: TextEditorDecorationType | undefined;
  private listeners: { dispose(): unknown }[] = [];

  private start(): void {
    this.type = window.createTextEditorDecorationType({
      after: { color: new ThemeColor("editorCodeLens.foreground"), fontStyle: "italic", margin: "0 0 0 1em" },
    });
    this.listeners = [
      // A change moves the lines the timings were drawn on.
      workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0 && this.results.delete(event.document.uri.toString())) {
          this.redraw();
        }
      }),
      window.onDidChangeVisibleTextEditors(() => this.redraw()),
    ];
  }

  show(editor: TextEditor, result: Timings): void {
    if (this.type === undefined) {
      this.start();
    }
    this.results.set(editor.document.uri.toString(), result);
    this.redraw();
  }

  clear(): void {
    this.results.clear();
    this.redraw();
  }

  private redraw(): void {
    const type = this.type;
    if (type === undefined) {
      return;
    }
    for (const editor of window.visibleTextEditors) {
      const result = this.results.get(editor.document.uri.toString());
      editor.setDecorations(type, result === undefined ? [] : decorations(editor, result));
    }
  }

  dispose(): void {
    for (const l of this.listeners) {
      l.dispose();
    }
    this.type?.dispose();
    this.results.clear();
  }
}

function decorations(editor: TextEditor, result: Timings): DecorationOptions[] {
  return result.timings
    .filter((t) => t.end < editor.document.lineCount)
    .map((t) => {
      const end = editor.document.lineAt(t.end).range.end;
      const hover = new MarkdownString();
      hover.appendMarkdown(`**Line timing**, lines ${t.start + 1}-${t.end + 1}\n\n`);
      if (t.ok) {
        hover.appendText(`Time ${durationText(t.ns)} by .z.p`);
        hover.appendText(t.bytes === undefined ? " (a system command: no memory figure)." : `, ${bytesText(t.bytes)} allocated by \\ts.`);
        hover.appendText(` The timing itself adds about ${durationText(result.overheadNs)}.`);
      } else {
        // The error as text in a code block, whatever lines it holds (#1264).
        hover.appendText("Failed; the statements after it did not run.");
        hover.appendCodeblock(`'${t.error ?? "failed"}`, "text");
      }
      return { range: new Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: decorationText(t) } } };
    });
}
