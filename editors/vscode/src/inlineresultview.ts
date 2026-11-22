// Inline results after Run Line (#1047): after Run Line or Run Selection,
// the answer's short form (`inlineresult.ts`) is drawn after the end of the
// line it came from, as a decoration, until that line is edited or Clear
// Inline Results is run. It draws only what a query the user ran already
// answered: it sends nothing. Off (q-lint.query.inlineResults.enable), the
// decorations are cleared and their type and listeners disposed.
import { Range, ThemeColor, commands, window, workspace, type Disposable, type ExtensionContext, type TextEditor, type TextEditorDecorationType } from "vscode";
import { shiftLines, shortForm, type Answered } from "./inlineresult";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "inlineResults");

export function registerInlineResults(
  context: ExtensionContext,
  live: Pick<Live, "onDidAnswer">,
): { shown: (uri: string) => { line: number; text: string }[]; active: () => boolean; clear: () => string | undefined } {
  /// Each document's results: line to text.
  const results = new Map<string, Map<number, { text: string; hover: string }>>();
  let decoration: TextEditorDecorationType | undefined;
  let listeners: Disposable[] = [];

  const draw = (editor: TextEditor): void => {
    if (decoration === undefined) {
      return;
    }
    const lines = results.get(editor.document.uri.toString()) ?? new Map();
    editor.setDecorations(
      decoration,
      [...lines.entries()]
        .filter(([line]) => line < editor.document.lineCount)
        .map(([line, r]) => {
          const end = editor.document.lineAt(line).range.end;
          return { range: new Range(end, end), hoverMessage: r.hover, renderOptions: { after: { contentText: ` => ${r.text}` } } };
        }),
    );
  };
  const drawAll = (uri?: string): void => {
    for (const editor of window.visibleTextEditors) {
      if (uri === undefined || editor.document.uri.toString() === uri) {
        draw(editor);
      }
    }
  };
  const answered = (a: Answered): void => {
    const lines = results.get(a.uri) ?? new Map();
    const text = shortForm(a.answer);
    lines.set(a.line, { text, hover: `${a.process}, ${a.millis} ms: ${a.answer.ok ? a.answer.text.join("\n").slice(0, 2000) : a.answer.error}` });
    results.set(a.uri, lines);
    drawAll(a.uri);
  };
  const start = (): void => {
    if (decoration !== undefined) {
      return;
    }
    decoration = window.createTextEditorDecorationType({
      after: { color: new ThemeColor("editorCodeLens.foreground"), fontStyle: "italic", margin: "0 0 0 1em" },
    });
    listeners = [
      live.onDidAnswer(answered),
      workspace.onDidChangeTextDocument((event) => {
        const key = event.document.uri.toString();
        const lines = results.get(key);
        if (lines === undefined || event.contentChanges.length === 0) {
          return;
        }
        let kept = new Map(lines);
        for (const change of event.contentChanges) {
          const added = (change.text.match(/\n/g) ?? []).length;
          const moved = shiftLines([...kept.keys()], change.range.start.line, change.range.end.line, added);
          const before = [...kept.keys()].filter((l) => l < change.range.start.line || l > change.range.end.line);
          kept = new Map(before.map((l, i) => [moved[i], kept.get(l)!]));
        }
        results.set(key, kept);
        drawAll(key);
      }),
      window.onDidChangeVisibleTextEditors(() => drawAll()),
      workspace.onDidCloseTextDocument((d) => void results.delete(d.uri.toString())),
    ];
  };
  const stop = (): void => {
    results.clear();
    for (const l of listeners) {
      l.dispose();
    }
    listeners = [];
    decoration?.dispose();
    decoration = undefined;
  };
  const sync = (): void => (on() ? start() : stop());
  const clear = (): string | undefined => {
    if (!on()) {
      const off = toolOff("inlineResults");
      void window.showInformationMessage(off);
      return off;
    }
    const uris = [...results.keys()];
    results.clear();
    for (const uri of uris) {
      drawAll(uri);
    }
    return undefined;
  };
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.query.inlineResults") && sync()),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.clearInlineResults, clear),
    { dispose: stop },
  );
  sync();
  return {
    shown: (uri) => [...(results.get(uri) ?? new Map()).entries()].map(([line, r]) => ({ line, text: r.text })).sort((a, b) => a.line - b.line),
    active: () => decoration !== undefined,
    clear,
  };
}
