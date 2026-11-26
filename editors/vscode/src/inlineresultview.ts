// Inline results after Run Line (#1047): after Run Line or Run Selection,
// the answer's short form (`inlineresult.ts`) is drawn after the end of the
// line it came from, as a decoration, until that line is edited or Clear
// Inline Results is run. It draws only what a query the user ran already
// answered: it sends nothing. Off (q-lint.query.inlineResults.enable), the
// decorations are cleared and their type and listeners disposed.
import { MarkdownString, Range, ThemeColor, commands, window, workspace, type Disposable, type ExtensionContext, type TextEditor, type TextEditorDecorationType } from "vscode";
import { hoverForm, shiftLines, shortForm, type Answered } from "./inlineresult";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";
import { plainMessage } from "./history";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "inlineResults");

export function registerInlineResults(
  context: ExtensionContext,
  live: Pick<Live, "onDidAnswer">,
): { shown: (uri: string) => { line: number; text: string }[]; active: () => boolean; clear: () => string | undefined } {
  /// Each document's results: line to text.
  const results = new Map<string, Map<number, { text: string; hover: MarkdownString }>>();
  /// Each document's recent edits, by the version each made: a query sent
  /// at an older version is answered at the line those edits moved it to,
  /// not the line it was on (#2553).
  const edits = new Map<string, { version: number; changes: { start: number; end: number; added: number }[] }[]>();
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
  /// The line `a` is on now: moved by what was edited since it was sent;
  /// undefined when its own line was edited, the edits are no longer all
  /// kept, or its document was closed meanwhile.
  const lineNow = (a: Answered): number | undefined => {
    if (a.version === undefined) {
      return a.line;
    }
    const document = workspace.textDocuments.find((d) => d.uri.toString() === a.uri);
    if (document === undefined) {
      return undefined;
    }
    const since = (edits.get(a.uri) ?? []).filter((e) => e.version > a.version!);
    if (since.length !== document.version - a.version) {
      return undefined;
    }
    let line: number | undefined = a.line;
    for (const e of since) {
      for (const c of e.changes) {
        line = line === undefined ? undefined : shiftLines([line], c.start, c.end, c.added)[0];
      }
    }
    return line;
  };
  const answered = (a: Answered): void => {
    const at = lineNow(a);
    if (at === undefined) {
      return;
    }
    a = { ...a, line: at };
    const lines = results.get(a.uri) ?? new Map();
    const text = shortForm(a.answer);
    // q's output as text in a code block: a "---" under a header row is no
    // heading, a `*` no emphasis (#1264).
    const hover = new MarkdownString().appendText(`${a.process}, ${a.millis} ms:`);
    hover.appendCodeblock(hoverForm(a.answer), "text");
    lines.set(a.line, { text, hover });
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
        if (event.contentChanges.length > 0) {
          const log = edits.get(key) ?? [];
          log.push({
            version: event.document.version,
            changes: event.contentChanges.map((c) => ({ start: c.range.start.line, end: c.range.end.line, added: (c.text.match(/\n/g) ?? []).length })),
          });
          edits.set(key, log.slice(-200));
        }
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
      workspace.onDidCloseTextDocument((d) => {
        results.delete(d.uri.toString());
        edits.delete(d.uri.toString());
      }),
    ];
  };
  const stop = (): void => {
    results.clear();
    edits.clear();
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
      void window.showInformationMessage(plainMessage(off));
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
