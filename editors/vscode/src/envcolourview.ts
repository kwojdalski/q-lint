// The environment colour (#1035): while the connected process carries a
// coloured tag, a status bar item in that colour names it, and each q
// editor has a border of it down its left side. Nothing is written to any
// settings file - the window's title bar is left as the theme draws it -
// and nothing is sent to a process. Off (the default), the item and the
// decoration are disposed and no listener is left.
import {
  Range,
  StatusBarAlignment,
  ThemeColor,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type StatusBarItem,
  type TextEditorDecorationType,
} from "vscode";
import { readAdmin } from "./admin";
import { envColourOf, envPaint, readEnvColours } from "./envcolour";
import type { Live } from "./live";

const Q_LANGUAGES = new Set(["q", "k", "quke"]);

export class EnvironmentColour {
  private item: StatusBarItem | undefined;
  private decoration: { type: TextEditorDecorationType; colour: string } | undefined;
  private listeners: Disposable[] = [];
  private shown: { label: string; tag: string; colour: string } | undefined;

  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "activeProcess" | "onDidChange">,
  ) {
    context.subscriptions.push(
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.processes.environmentColor")) {
          this.sync();
        }
      }),
      { dispose: () => this.stop() },
    );
    this.sync();
  }

  /// What is drawn now, for tests and the e2e run.
  state(): { label: string; tag: string; colour: string; editors: number } | undefined {
    return this.shown === undefined ? undefined : { ...this.shown, editors: this.decorated };
  }

  private decorated = 0;

  private enabled(): boolean {
    return readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).environmentColor;
  }

  /// Listen while on, and draw; turned off, take everything away.
  private sync(): void {
    if (!this.enabled()) {
      this.stop();
      return;
    }
    if (this.listeners.length === 0) {
      this.listeners = [
        this.live.onDidChange((what) => what !== "queried" && this.draw()),
        window.onDidChangeVisibleTextEditors(() => this.paintEditors()),
        workspace.onDidChangeTextDocument((event) => {
          if (this.decoration !== undefined && window.visibleTextEditors.some((e) => e.document === event.document)) {
            this.paintEditors();
          }
        }),
      ];
    }
    this.draw();
  }

  private stop(): void {
    for (const l of this.listeners) {
      l.dispose();
    }
    this.listeners = [];
    this.item?.dispose();
    this.item = undefined;
    this.decoration?.type.dispose();
    this.decoration = undefined;
    this.shown = undefined;
    this.decorated = 0;
  }

  private draw(): void {
    const process = this.live.activeProcess();
    const colours = readEnvColours(workspace.getConfiguration("q-lint").get<unknown>("processes.environmentColor.colors"));
    const found = process === undefined ? undefined : envColourOf(process.tags, colours);
    if (process === undefined || found === undefined) {
      this.item?.hide();
      this.decoration?.type.dispose();
      this.decoration = undefined;
      this.shown = undefined;
      this.decorated = 0;
      return;
    }
    const paint = envPaint(found.colour);
    this.item ??= window.createStatusBarItem("q-lint.environment", StatusBarAlignment.Left, 49);
    this.item.name = "q-lint: environment colour";
    this.item.text = `$(circle-large-filled) ${found.tag.toUpperCase()}`;
    this.item.tooltip = `Connected to ${process.label}, tagged ${found.tag} (q-lint.processes.environmentColor).`;
    this.item.backgroundColor = paint.background === undefined ? undefined : new ThemeColor(paint.background);
    this.item.color = paint.background !== undefined ? undefined : paint.hex ?? (paint.theme === undefined ? undefined : new ThemeColor(paint.theme));
    this.item.show();
    if (this.decoration?.colour !== found.colour) {
      this.decoration?.type.dispose();
      const borderColor = paint.hex ?? (paint.theme === undefined ? undefined : new ThemeColor(paint.theme));
      this.decoration = {
        colour: found.colour,
        type: window.createTextEditorDecorationType({ isWholeLine: true, borderStyle: "solid", borderWidth: "0 0 0 3px", borderColor, overviewRulerColor: borderColor }),
      };
    }
    this.shown = { label: process.label, tag: found.tag, colour: found.colour };
    this.paintEditors();
  }

  /// The border on every visible q editor, over all its lines.
  private paintEditors(): void {
    const decoration = this.decoration;
    if (decoration === undefined) {
      return;
    }
    let n = 0;
    for (const editor of window.visibleTextEditors ?? []) {
      if (Q_LANGUAGES.has(editor.document.languageId)) {
        const last = Math.max(0, editor.document.lineCount - 1);
        editor.setDecorations(decoration.type, [new Range(0, 0, last, 0)]);
        n++;
      }
    }
    this.decorated = n;
  }
}
