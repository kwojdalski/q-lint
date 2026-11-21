// Snapshot tests (#981): **Record Query Snapshot** runs the query at the
// cursor and writes its result as `__snapshots__/<name>.qsnap` beside the
// file; **Update Snapshot** runs a snapshot's query again and rewrites its
// result. Each shows what it will write and asks first, a replacement
// included, and writes nothing on Escape. The Test Explorer lists and runs
// the files (`testexplorer.ts`); `snapshot.ts` has the format. Nothing is
// registered to act while q-lint.snapshotTests.enable is off: the commands
// are hidden and refuse.
import { dirname, join } from "node:path";
import { Uri, commands, window, workspace, type ExtensionContext } from "vscode";
import { editorFeatureOff, editorFeatureOn } from "./editorfeatures";
import type { Live } from "./live";
import { readAnswer } from "./query";
import {
  SNAPSHOT_COMMANDS,
  SNAPSHOT_DIRECTORY,
  SNAPSHOT_EXTENSION,
  SNAPSHOT_RUN,
  formatSnapshot,
  parseSnapshot,
  preview,
  sameResult,
  snapshotName,
  validName,
} from "./snapshot";
import { statements } from "./statements";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "snapshotTests");

/// Register the commands; `written` is told when a file was written, for
/// the Test Explorer to list it.
export function registerSnapshots(context: ExtensionContext, live: Live, written: () => void): void {
  const refuse = (): boolean => {
    if (!on()) {
      void window.showInformationMessage(editorFeatureOff("snapshotTests"));
      return true;
    }
    return false;
  };
  context.subscriptions.push(
    commands.registerCommand(SNAPSHOT_COMMANDS.record, async () => {
      if (!refuse() && (await record(live))) {
        written();
      }
    }),
    commands.registerCommand(SNAPSHOT_COMMANDS.update, async (arg?: unknown) => {
      if (!refuse() && (await update(live, arg))) {
        written();
      }
    }),
  );
}

/// The query's result as a snapshot records it, or undefined having said why.
async function result(live: Live, query: string): Promise<string | undefined> {
  const done = await live.runOnActive(query, async (connection) => readAnswer(await connection.call(SNAPSHOT_RUN, statements(query))));
  if (done === undefined) {
    return undefined;
  }
  if (!done.value.ok) {
    void window.showErrorMessage(`q-lint: the query failed on ${done.process} ('${done.value.error}); no snapshot was written.`);
    return undefined;
  }
  return done.value.text.join("\n");
}

async function existing(uri: Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return undefined;
  }
}

/// Write `text` to `uri` once the user agrees, having seen it.
async function confirmWrite(uri: Uri, text: string, replacing: boolean): Promise<boolean> {
  const yes = replacing ? "Replace" : "Write";
  const answer = await window.showWarningMessage(
    `${replacing ? "Replace the snapshot" : "Write a snapshot to"} ${workspace.asRelativePath(uri)}?`,
    { modal: true, detail: preview(text) },
    yes,
  );
  if (answer !== yes) {
    return false;
  }
  await workspace.fs.createDirectory(Uri.file(dirname(uri.fsPath)));
  await workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
  return true;
}

async function record(live: Live): Promise<boolean> {
  const editor = window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== "file") {
    void window.showInformationMessage("q-lint: open the q file the query is in; its snapshot is written beside it.");
    return false;
  }
  const query = await live.codeFromEditor();
  if (query === undefined) {
    return false;
  }
  const name = await window.showInputBox({
    title: "Record Query Snapshot",
    prompt: `The snapshot's name: written to ${SNAPSHOT_DIRECTORY}/<name>${SNAPSHOT_EXTENSION} beside this file`,
    value: snapshotName(query),
    validateInput: (v) => (validName(v) ? undefined : "Letters, digits, '_', '.' and '-', not starting with '.'"),
  });
  if (name === undefined || !validName(name)) {
    return false;
  }
  const target = Uri.file(join(dirname(editor.document.uri.fsPath), SNAPSHOT_DIRECTORY, `${name}${SNAPSHOT_EXTENSION}`));
  const got = await result(live, query);
  if (got === undefined) {
    return false;
  }
  const before = await existing(target);
  const old = before === undefined ? undefined : parseSnapshot(before);
  if (old !== undefined && old.query === query.trim() && sameResult(old.result, got)) {
    void window.showInformationMessage(`q-lint: ${workspace.asRelativePath(target)} already holds this result.`);
    return false;
  }
  return confirmWrite(target, formatSnapshot({ query, result: got }), before !== undefined);
}

async function update(live: Live, arg: unknown): Promise<boolean> {
  const given = arg as { uri?: Uri; fsPath?: string } | undefined;
  const uri =
    given?.uri ??
    (typeof given?.fsPath === "string" ? (given as Uri) : undefined) ??
    (window.activeTextEditor?.document.uri.fsPath.endsWith(SNAPSHOT_EXTENSION) ? window.activeTextEditor.document.uri : undefined);
  if (uri === undefined) {
    void window.showInformationMessage(`q-lint: open a ${SNAPSHOT_EXTENSION} file, or choose a snapshot in the Testing view, to update it.`);
    return false;
  }
  const text = await existing(uri);
  const snapshot = text === undefined ? undefined : parseSnapshot(text);
  if (snapshot === undefined) {
    void window.showErrorMessage(`q-lint: ${workspace.asRelativePath(uri)} is not a q-lint snapshot.`);
    return false;
  }
  const got = await result(live, snapshot.query);
  if (got === undefined) {
    return false;
  }
  if (sameResult(snapshot.result, got)) {
    void window.showInformationMessage(`q-lint: ${workspace.asRelativePath(uri)} already holds this result.`);
    return false;
  }
  return confirmWrite(uri, formatSnapshot({ query: snapshot.query, result: got }), true);
}
