// Generate a test stub (#982): a code action on a function definition, and
// **Generate Test Stub**, write a `test_` function for it in the style of
// its test file - `test_<name>.q` or `<name>_test.q` in the workspace, or a
// new `tests/test_<name>.q` (beside the file when there is no `tests`
// folder). It shows the stub and the file and asks first; an existing file
// is only added to, at the end of what q reads of it, as an edit that can be
// undone, and a new one
// is never written over. `teststub.ts` has the rules. Nothing is registered
// while q-lint.testStub.enable is off: the action is not offered and the
// command refuses.
import {
  CodeAction,
  CodeActionKind,
  Position,
  Range,
  RelativePattern,
  Selection,
  Uri,
  WorkspaceEdit,
  commands,
  languages,
  window,
  workspace,
  type CodeActionProvider,
  type ExtensionContext,
  type TextDocument,
} from "vscode";
import { editorFeatureOff, editorFeatureOn } from "./editorfeatures";
import { TEST_STUB_COMMAND, detectStyle, endContext, functionAt, newTestPath, stubText, testFilePatterns, testName, unreadFrom, type Target } from "./teststub";
import { isBlankLine } from "./statements";
import { plainMessage } from "./history";
import { assertWritableIn } from "./workspacewrite";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "testStub");

/// The action's kind, made when first asked for.
const stubKind = (): CodeActionKind => CodeActionKind.Refactor.append("generateTest");

class StubActions implements CodeActionProvider {
  provideCodeActions(document: TextDocument, range: Range): CodeAction[] {
    // A test file goes beside a file on disk: an untitled editor or a
    // notebook cell has none (#1600).
    if (document.uri.scheme !== "file") {
      return [];
    }
    const target = functionAt(document.getText(), range.start.line);
    if (target === undefined) {
      return [];
    }
    const action = new CodeAction(`Generate a test for ${target.name}`, stubKind());
    action.command = { command: TEST_STUB_COMMAND, title: action.title, arguments: [document.uri, range.start.line] };
    return [action];
  }
}

async function read(uri: Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return undefined;
  }
}

/// The text of `uri` as the editor has it, unsaved edits included: the stub
/// is inserted into that document, so its end is found there (#1076).
async function open(uri: Uri): Promise<string | undefined> {
  try {
    return (await workspace.openTextDocument(uri)).getText();
  } catch {
    return undefined;
  }
}

/// Where the stub for `source`'s function goes: an existing test file, or a
/// new one, with the text the style is read from.
async function testFile(source: Uri): Promise<{ uri: Uri; text: string | undefined; styleFrom: string }> {
  // Searched in `source`'s own folder: in a multi-root workspace another
  // folder's test_<name>.q tests another repository's file (#1837).
  const own = workspace.getWorkspaceFolder(source);
  const within = (glob: string): string | RelativePattern => (own !== undefined ? new RelativePattern(own, glob) : glob);
  for (const pattern of testFilePatterns(source.fsPath)) {
    const found = (await workspace.findFiles(within(pattern), "**/node_modules/**", 20)).sort((a, b) => a.fsPath.length - b.fsPath.length);
    if (found.length > 0) {
      const text = (await open(found[0])) ?? "";
      return { uri: found[0], text, styleFrom: text };
    }
  }
  const folder = own?.uri;
  const hasTests =
    folder !== undefined &&
    (await workspace.fs.stat(Uri.joinPath(folder, "tests")).then(
      () => true,
      () => false,
    ));
  const other = (await workspace.findFiles(within("**/test_*.q"), "**/node_modules/**", 1))[0];
  return {
    uri: Uri.file(newTestPath(source.fsPath, folder?.fsPath, hasTests)),
    text: undefined,
    styleFrom: other === undefined ? "" : ((await read(other)) ?? ""),
  };
}

/// Write the stub for the function at `line` of `uri`, once asked.
export async function generateStub(uri?: Uri, line?: number): Promise<boolean> {
  if (!on()) {
    void window.showInformationMessage(plainMessage(editorFeatureOff("testStub")));
    return false;
  }
  const editor = window.activeTextEditor;
  const source = uri ?? editor?.document.uri;
  const at = line ?? editor?.selection.active.line;
  if (source === undefined || at === undefined) {
    void window.showInformationMessage("q-lint: put the cursor in a function's definition to generate its test.");
    return false;
  }
  // An untitled file or a notebook cell has no folder to put a test in: its
  // stub went to the disk root, or beside the notebook (#1525).
  if (source.scheme !== "file") {
    void window.showInformationMessage("q-lint: save the file first: a test stub goes beside a q file on disk.");
    return false;
  }
  const document = await workspace.openTextDocument(source);
  const target: Target | undefined = functionAt(document.getText(), at);
  if (target === undefined) {
    void window.showInformationMessage("q-lint: the cursor is not in a function's definition (a top-level `name:{...}` that is not a test).");
    return false;
  }
  const file = await testFile(source);
  const style = detectStyle(file.styleFrom);
  const name = testName(target, style, file.text ?? "");
  const stub = stubText(target, name, style, endContext(file.text ?? ""));
  const yes = "Add Test";
  const answer = await window.showInformationMessage(
    plainMessage(`${file.text === undefined ? "Create" : "Add to"} ${workspace.asRelativePath(file.uri)}: ${name}?`),
    { modal: true, detail: stub },
    yes,
  );
  if (answer !== yes) {
    return false;
  }
  let stubLine: number;
  if (file.text === undefined) {
    // Checked again just before: a file made meanwhile is not written over.
    if ((await read(file.uri)) !== undefined) {
      void window.showWarningMessage(plainMessage(`q-lint: ${workspace.asRelativePath(file.uri)} exists now; nothing was written.`));
      return false;
    }
    const content = `/ Tests for ${workspace.asRelativePath(source)}\n\n${stub}`;
    try {
      // A dangling link the repository ships reads as no file (#1830).
      assertWritableIn(workspace.workspaceFolders, file.uri.fsPath);
      await workspace.fs.writeFile(file.uri, Buffer.from(content, "utf8"));
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${file.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return false;
    }
    stubLine = 2;
  } else {
    const text = (await open(file.uri)) ?? file.text;
    const lines = text.split("\n");
    const ends = text === "" || text.endsWith("\n");
    const edit = new WorkspaceEdit();
    // Before the text q does not read - after the script's end, or in a
    // block comment left open - where the test would never be defined (#2908).
    const unread = unreadFrom(text);
    const spaced = unread !== undefined && unread > 0 && !isBlankLine(lines[unread - 1]);
    if (unread !== undefined) {
      edit.insert(file.uri, new Position(unread, 0), `${spaced ? "\n" : ""}${stub}\n`);
    } else {
      const end = new Position(lines.length - 1, lines[lines.length - 1].length);
      edit.insert(file.uri, end, `${ends ? "" : "\n"}\n${stub}`);
    }
    if (!(await workspace.applyEdit(edit))) {
      void window.showErrorMessage(plainMessage(`q-lint: could not add the test to ${workspace.asRelativePath(file.uri)}.`));
      return false;
    }
    stubLine = unread !== undefined ? unread + (spaced ? 1 : 0) : lines.length + (ends ? 0 : 1);
  }
  const shown = await window.showTextDocument(file.uri);
  const select = new Position(stubLine, 0);
  shown.selection = new Selection(select, select);
  shown.revealRange(new Range(select, select));
  return true;
}

/// Register the code action while q-lint.testStub.enable is on, and the
/// command.
export function registerTestStubs(context: ExtensionContext): { registered: () => boolean } {
  let provider: { dispose(): unknown } | undefined;
  const sync = (): void => {
    if (on() && provider === undefined) {
      provider = languages.registerCodeActionsProvider({ language: "q", scheme: "file" }, new StubActions(), { providedCodeActionKinds: [stubKind()] });
    } else if (!on() && provider !== undefined) {
      provider.dispose();
      provider = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    commands.registerCommand(TEST_STUB_COMMAND, (uri?: Uri, line?: number) => generateStub(uri, line)),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.testStub") && sync()),
    { dispose: () => provider?.dispose() },
  );
  return { registered: () => provider !== undefined };
}
