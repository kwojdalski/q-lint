// Logpoints (#984): **Add Logpoint** wraps the function under the cursor (or
// one named) on the active process so each call's arguments are printed
// there with `0N!` and kept; **Remove Logpoint** and **Remove All
// Logpoints** put the functions back; **Show Logpoint Hits** reads the calls
// kept. A function with a logpoint added from here is marked where the
// editor defines it. `logpoint.ts` has what is sent.
//
// Adding and removing change the process, so they go as a query does,
// through the read-only guard (#918); reading the hits goes as the Process
// Explorer reads, with a fixed lambda that changes nothing. Nothing is sent
// on its own: only these commands send. While q-lint.logpoints.enable is off
// the commands are hidden and refuse, and the marks are cleared.
import {
  ThemeColor,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type OutputChannel,
  type TextEditor,
  type TextEditorDecorationType,
} from "vscode";
import { definitions } from "./definitions";
import { editorFeatureOff, editorFeatureOn } from "./editorfeatures";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { LOGPOINT_COMMANDS, LOG_ADD, LOG_LIST, LOG_REMOVE, hitLines, readLogpoints } from "./logpoint";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "logpoints");

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/// The name of the function whose definition holds the cursor.
function nameAtCursor(editor: TextEditor | undefined): string | undefined {
  if (editor === undefined || editor.document.languageId !== "q") {
    return undefined;
  }
  const line = editor.selection.active.line;
  return definitions(editor.document.getText()).find((d) => d.line <= line && line <= d.endLine)?.name;
}

export function registerLogpoints(
  context: ExtensionContext,
  live: Live,
): { logged: () => Record<string, string[]>; marked: () => number[] } {
  /// The names with a logpoint, by process, as this window last saw them.
  const logged = new Map<string, Set<string>>();
  let decoration: TextEditorDecorationType | undefined;
  let marked: number[] = [];
  let output: OutputChannel | undefined;

  const mark = (): void => {
    const editor = window.activeTextEditor;
    const process = live.activeLabel();
    if (decoration === undefined || editor === undefined) {
      marked = [];
      return;
    }
    const names = process === undefined ? undefined : logged.get(process);
    const lines =
      names === undefined || editor.document.languageId !== "q"
        ? []
        : definitions(editor.document.getText())
            .filter((d) => names.has(d.name))
            .map((d) => d.line);
    marked = lines;
    editor.setDecorations(
      decoration,
      lines.map((line) => ({
        range: editor.document.lineAt(line).range,
        renderOptions: { after: { contentText: `  logpoint on ${process}` } },
      })),
    );
  };
  const sync = (): void => {
    if (on() && decoration === undefined) {
      decoration = window.createTextEditorDecorationType({
        after: { color: new ThemeColor("editorCodeLens.foreground"), fontStyle: "italic" },
        overviewRulerColor: new ThemeColor("editorInfo.foreground"),
      });
      mark();
    } else if (!on() && decoration !== undefined) {
      decoration.dispose();
      decoration = undefined;
      marked = [];
    }
  };
  const refuse = (): boolean => {
    if (!on()) {
      void window.showInformationMessage(editorFeatureOff("logpoints"));
      return true;
    }
    return false;
  };
  /// What the active process holds, read without changing anything.
  const list = async (): Promise<{ process: string; names: string[]; hits: ReturnType<typeof readLogpoints>["hits"] } | undefined> => {
    if (live.activeProcess() === undefined) {
      void window.showInformationMessage("q-lint: connect to a q process first.");
      return undefined;
    }
    const got = await borrowWhenFree(live, async (connection, process) => ({ process: process.label, ...readLogpoints(await connection.call(LOG_LIST)) }));
    if (got === undefined) {
      void window.showInformationMessage("q-lint: a query is still running; try again once it ends.");
      return undefined;
    }
    logged.set(got.value.process, new Set(got.value.names));
    mark();
    return got.value;
  };

  const add = async (name?: unknown): Promise<void> => {
    if (refuse()) {
      return;
    }
    let target = typeof name === "string" ? name : nameAtCursor(window.activeTextEditor);
    if (target === undefined) {
      target = await window.showInputBox({ title: "Add Logpoint", prompt: "The function to log the calls of, as the process names it", placeHolder: ".ns.f" });
    }
    if (target === undefined || target.trim() === "") {
      return;
    }
    const fn = target.trim();
    try {
      const done = await live.runOnActive(LOG_ADD, async (connection) => String(await connection.call(LOG_ADD, fn)));
      if (done === undefined) {
        return;
      }
      const names = logged.get(done.process) ?? new Set<string>();
      names.add(fn);
      logged.set(done.process, names);
      mark();
      void window.showInformationMessage(`q-lint: each call of ${fn} on ${done.process} is printed there with 0N! until the logpoint is removed.`);
    } catch (error) {
      void window.showErrorMessage(`q-lint: no logpoint on ${fn}: ${message(error)}`);
    }
  };

  /// Remove `fn`'s logpoint on `from`, the process it was listed on and
  /// no other (#1294); whether it was sent.
  const removeOne = async (fn: string, from: string): Promise<boolean> => {
    const done = await live.runOnActive(LOG_REMOVE, async (connection) => (await connection.call(LOG_REMOVE, fn)) === true, "ask", from);
    if (done === undefined) {
      return false;
    }
    logged.get(done.process)?.delete(fn);
    if (!done.value) {
      void window.showWarningMessage(`q-lint: ${fn} was redefined on ${done.process} while it had a logpoint; it is left as it is now.`);
    }
    return true;
  };

  const remove = async (name?: unknown): Promise<void> => {
    if (refuse()) {
      return;
    }
    const held = await list();
    if (held === undefined) {
      return;
    }
    if (held.names.length === 0) {
      void window.showInformationMessage(`q-lint: no function on ${held.process} has a logpoint.`);
      return;
    }
    const wanted = typeof name === "string" ? name : nameAtCursor(window.activeTextEditor);
    const fn =
      wanted !== undefined && held.names.includes(wanted)
        ? wanted
        : held.names.length === 1
          ? held.names[0]
          : await window.showQuickPick(held.names, { title: "Remove Logpoint", placeHolder: `A function with a logpoint on ${held.process}` });
    if (fn === undefined) {
      return;
    }
    try {
      await removeOne(fn, held.process);
    } catch (error) {
      void window.showErrorMessage(`q-lint: the logpoint on ${fn} was not removed: ${message(error)}`);
    }
    mark();
  };

  const removeAll = async (): Promise<void> => {
    if (refuse()) {
      return;
    }
    const held = await list();
    if (held === undefined) {
      return;
    }
    let removed = 0;
    for (const fn of held.names) {
      try {
        removed += (await removeOne(fn, held.process)) ? 1 : 0;
      } catch (error) {
        void window.showErrorMessage(`q-lint: the logpoint on ${fn} was not removed: ${message(error)}`);
        if (live.activeLabel() !== held.process) {
          break;
        }
      }
    }
    mark();
    void window.showInformationMessage(`q-lint: ${removed} logpoint${removed === 1 ? "" : "s"} removed from ${held.process}.`);
  };

  const hits = async (): Promise<void> => {
    if (refuse()) {
      return;
    }
    const held = await list();
    if (held === undefined) {
      return;
    }
    if (output === undefined) {
      output = window.createOutputChannel("q-lint: logpoints");
      context.subscriptions.push(output);
    }
    output.clear();
    for (const line of hitLines(held.process, held.hits)) {
      output.appendLine(line);
    }
    output.show(true);
  };

  sync();
  context.subscriptions.push(
    commands.registerCommand(LOGPOINT_COMMANDS.add, add),
    commands.registerCommand(LOGPOINT_COMMANDS.remove, remove),
    commands.registerCommand(LOGPOINT_COMMANDS.removeAll, removeAll),
    commands.registerCommand(LOGPOINT_COMMANDS.hits, hits),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.logpoints") && sync()),
    window.onDidChangeActiveTextEditor(() => mark()),
    workspace.onDidSaveTextDocument(() => mark()),
    live.onDidChange((what) => what !== "queried" && mark()),
    { dispose: () => decoration?.dispose() },
  );
  return {
    logged: () => Object.fromEntries([...logged].map(([process, names]) => [process, [...names]])),
    marked: () => marked,
  };
}
