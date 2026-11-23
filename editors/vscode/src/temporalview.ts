// The temporal hover and Convert Temporal Value (#969): hovering a q
// temporal literal, or a number as long as an epoch, in a q editor shows
// what it converts to, and the command replaces the selection with one of
// those conversions. `temporal.ts` has the arithmetic.
//
// Nothing is sent to a process: every conversion is computed here. With
// q-lint.temporalHover.enable off no hover provider is registered and the
// command refuses.
import {
  commands,
  Hover,
  MarkdownString,
  Range,
  languages,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type Position,
  type TextDocument,
} from "vscode";
import { editorFeatureOff, editorFeatureOn } from "./editorfeatures";
import { CONVERT_TEMPORAL, convertText, hoverMarkdown, temporalAt } from "./temporal";
import { plainMessage } from "./history";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "temporalHover");

/// The hover for `position` of `document`, while the feature is on.
export function temporalHover(document: TextDocument, position: Position): Hover | undefined {
  if (!on()) {
    return undefined;
  }
  const found = temporalAt(document.lineAt(position.line).text, position.character);
  if (found === undefined || found.conversions.length === 0) {
    return undefined;
  }
  return new Hover(new MarkdownString(hoverMarkdown(found)), new Range(position.line, found.start, position.line, found.end));
}

/// Register the hover while q-lint.temporalHover.enable is on, and Convert
/// Temporal Value always. `target` (a keybinding's or a test's argument)
/// names the conversion by its label, without asking.
export function registerTemporal(context: ExtensionContext): { registered: () => boolean; hover: typeof temporalHover } {
  let provider: Disposable | undefined;
  const sync = (): void => {
    if (on() && provider === undefined) {
      provider = languages.registerHoverProvider({ language: "q" }, { provideHover: (d, p) => temporalHover(d, p) });
    } else if (!on() && provider !== undefined) {
      provider.dispose();
      provider = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    commands.registerCommand(CONVERT_TEMPORAL, (target?: string) => convert(target)),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.temporalHover") && sync()),
    { dispose: () => provider?.dispose() },
  );
  return { registered: () => provider !== undefined, hover: temporalHover };
}

/// Replace the selection, or the literal under the cursor, with a
/// conversion of it. The text put in, or undefined when nothing was.
async function convert(target?: string): Promise<string | undefined> {
  if (!on()) {
    void window.showInformationMessage(plainMessage(editorFeatureOff("temporalHover")));
    return undefined;
  }
  const editor = window.activeTextEditor;
  if (editor === undefined) {
    void window.showInformationMessage("q-lint: Convert Temporal Value converts the selection of an editor; open one first.");
    return undefined;
  }
  let range: Range;
  let found: ReturnType<typeof convertText>;
  if (editor.selection.isEmpty) {
    const at = editor.selection.active;
    const token = temporalAt(editor.document.lineAt(at.line).text, at.character);
    range = new Range(at.line, token?.start ?? at.character, at.line, token?.end ?? at.character);
    found = token;
  } else {
    range = new Range(editor.selection.start, editor.selection.end);
    found = convertText(editor.document.getText(range));
  }
  if (found === undefined || found.conversions.length === 0) {
    void window.showInformationMessage(
      "q-lint: select a q temporal value (2024.01.02D03:04:05, 2024.01.02, 0D01:00, 09:30:00.000, 0Np ...) or a number of 9 digits or more to convert.",
    );
    return undefined;
  }
  const picked =
    target !== undefined
      ? found.conversions.find((c) => c.label === target)
      : await window.showQuickPick(
          found.conversions.map((c) => ({ label: c.text, description: c.label.replace(/`/g, ""), conversion: c })),
          { title: `q-lint: convert the ${found.what} to` },
        ).then((p) => p?.conversion);
  if (picked === undefined) {
    if (target !== undefined) {
      void window.showInformationMessage(plainMessage(`q-lint: the ${found.what} has no conversion "${target}".`));
    }
    return undefined;
  }
  const done = await editor.edit((edit) => edit.replace(range, picked.text));
  return done ? picked.text : undefined;
}
