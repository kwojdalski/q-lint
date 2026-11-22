// Function diff between two processes (#1045): Diff Function Across
// Processes reads one function's definition on two processes and opens VS
// Code's side-by-side diff of them; Diff Namespace Across Processes reads
// every function of a namespace on both and lists the ones that differ or
// are on one side only, each opening the same diff. Each process is read
// over a connection of its own (`Live.callSeparate`), closed after, with
// one fixed read-only lambda (`fndiff.ts`) - so the active connection is
// left as it was and nothing on either process changes. The diff's two
// sides are `q-lint-fndiff:` documents, which VS Code never lets one type
// into. Off (q-lint.processes.functionDiff.enable), the commands refuse
// and nothing is sent.
import { EventEmitter, Uri, commands, window, workspace, type ExtensionContext, type TextDocumentContentProvider } from "vscode";
import { FUNCTION_TEXTS, compareTexts, nameProblem, readTexts, sideDocument, type Difference, type Texts } from "./fndiff";
import type { Live, ProcessArg } from "./live";
import type { Process } from "./processes";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";

export const DIFF_SCHEME = "q-lint-fndiff";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "functionDiff");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function say(text: string): string {
  void window.showInformationMessage(text);
  return text;
}

/// `f` called with `args` on `process` over a connection of its own,
/// closed after, within the process's own timeout (`Live.callSeparate`):
/// for fixed read-only lambdas only.
export function callApart(live: Pick<Live, "callSeparate">, process: Process, f: string, ...args: unknown[]): Promise<unknown> {
  return live.callSeparate(process, (connection) => connection.call(f, ...args));
}

/// The q name under the cursor in the active editor, dots and all.
export function nameAtCursor(): string | undefined {
  const editor = window.activeTextEditor;
  if (editor === undefined) {
    return undefined;
  }
  const range = editor.document.getWordRangeAtPosition(editor.selection.active, /\.?[A-Za-z][A-Za-z0-9_.]*/);
  return range === undefined ? undefined : editor.document.getText(range).replace(/\.$/, "");
}

export interface DiffState {
  name: string;
  first: string;
  second: string;
  differences: Difference[];
}

export function registerFunctionDiff(
  context: ExtensionContext,
  live: Live,
): { diff: (name?: string, a?: ProcessArg, b?: ProcessArg, namespace?: boolean) => Promise<DiffState | string>; last: () => DiffState | undefined } {
  const documents = new Map<string, string>();
  const changed = new EventEmitter<Uri>();
  const provider: TextDocumentContentProvider = {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => documents.get(uri.toString()) ?? "/ not read; run the diff again.\n",
  };
  let last: DiffState | undefined;

  const side = (process: string, name: string, text: string | undefined): Uri => {
    const uri = Uri.from({ scheme: DIFF_SCHEME, path: `/${process}/${name}.q`, query: process });
    documents.set(uri.toString(), sideDocument(name, process, text));
    changed.fire(uri);
    return uri;
  };
  const openDiff = async (name: string, first: string, a: Texts, second: string, b: Texts): Promise<void> => {
    await commands.executeCommand("vscode.diff", side(first, name, a.texts.get(name)), side(second, name, b.texts.get(name)), `${name}: ${first} vs ${second}`, { preview: true });
  };

  const diff = async (given?: string, firstArg?: ProcessArg, secondArg?: ProcessArg, namespace = false): Promise<DiffState | string> => {
    if (!on()) {
      return say(toolOff("functionDiff"));
    }
    const what = namespace ? "namespace" : "function";
    const name =
      given ??
      (await window.showInputBox({
        title: `Diff which ${what} across two processes?`,
        prompt: namespace ? "A namespace, as .lib: every function directly in it is compared." : "A function's name, as .lib.f.",
        value: namespace ? (nameAtCursor()?.match(/^\.[A-Za-z][A-Za-z0-9_]*/)?.[0] ?? "") : (nameAtCursor() ?? ""),
        validateInput: (v) => nameProblem(v),
      }));
    if (name === undefined) {
      return "no name";
    }
    const problem = nameProblem(name);
    if (problem !== undefined) {
      return say(`q-lint: "${name}" is not ${problem}.`);
    }
    const a = await live.choose(firstArg, `Diff ${name} (1 of 2): on which process?`);
    if (a === undefined) {
      return "no process";
    }
    const b = await live.choose(secondArg, `Diff ${name} (2 of 2): against which process?`);
    if (b === undefined) {
      return "no process";
    }
    if (a.label === b.label) {
      return say(`q-lint: a diff compares two processes; ${a.label} was chosen twice.`);
    }
    let read: [Texts, Texts];
    try {
      read = (await Promise.all([a, b].map(async (p) => readTexts(await callApart(live, p, FUNCTION_TEXTS, name.trim()))))) as [Texts, Texts];
    } catch (error) {
      return say(`q-lint: could not read ${name}: ${message(error)}`);
    }
    if (!on()) {
      return say(toolOff("functionDiff"));
    }
    const [ta, tb] = read;
    const trimmed = name.trim();
    const kinds = [ta.kind, tb.kind];
    if (kinds.every((k) => k === "missing" || k === "other")) {
      return say(`q-lint: ${trimmed} is neither a function nor a namespace on ${a.label} or ${b.label}.`);
    }
    const differences = compareTexts(ta.texts, tb.texts);
    last = { name: trimmed, first: a.label, second: b.label, differences };
    if (!namespace || (ta.kind !== "namespace" && tb.kind !== "namespace")) {
      const target = differences[0]?.name ?? trimmed;
      await openDiff(target, a.label, ta, b.label, tb);
      return last;
    }
    const changedOnes = differences.filter((d) => d.status !== "same");
    if (changedOnes.length === 0) {
      say(`q-lint: the ${differences.length} function${differences.length === 1 ? "" : "s"} of ${trimmed} are the same on ${a.label} and ${b.label}.`);
      return last;
    }
    const picked = await window.showQuickPick(
      changedOnes.map((d) => ({ label: d.name, description: d.status, name: d.name })),
      { title: `${trimmed}: ${changedOnes.length} of ${differences.length} function${differences.length === 1 ? "" : "s"} differ between ${a.label} and ${b.label}` },
    );
    if (picked !== undefined) {
      await openDiff(picked.name, a.label, ta, b.label, tb);
    }
    return last;
  };

  context.subscriptions.push(
    changed,
    workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider),
    workspace.onDidCloseTextDocument((d) => void (d.uri.scheme === DIFF_SCHEME && documents.delete(d.uri.toString()))),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.diffFunction, (name?: unknown, a?: ProcessArg, b?: ProcessArg) => diff(typeof name === "string" ? name : undefined, a, b, false)),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.diffNamespace, (name?: unknown, a?: ProcessArg, b?: ProcessArg) => diff(typeof name === "string" ? name : undefined, a, b, true)),
  );
  return { diff, last: () => last };
}
