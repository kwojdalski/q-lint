// Run the affected tests on save (#1059). When a q file is saved, the
// language server compares its top-level functions with the text this last
// saw of it and answers the tests that reach a changed one through the call
// graph (`q-lint/testsReaching`); those tests - and only those - are run by
// the Test Explorer, as its Run profile runs them: on the active connection,
// asking which process when there is none, and confirming a production one.
// One run at a time: a save while one runs waits for it.
//
// Off unless asked for (q-lint.testing.runAffectedOnSave.enable), since it
// sends code to a process at every save; off, nothing listens and nothing is
// kept. It needs the Test Explorer on (q-lint.testExplorer.enable).
import { window, workspace, type Disposable, type ExtensionContext, type TextDocument } from "vscode";
import type { Server } from "./editorfeatures";
import { languageOn } from "./languagefeatures";

export const TESTS_REACHING = "q-lint/testsReaching";

/// The Test Explorer ids of the tests the server answered, among `listed`:
/// a function test's id is its file's URI, `#`, and its name.
export function affectedIds(answer: unknown, listed: string[]): string[] {
  const a = answer as { tests?: unknown } | null | undefined;
  if (!a || !Array.isArray(a.tests)) {
    return [];
  }
  const ids = a.tests.flatMap((t: { uri?: unknown; name?: unknown }) => (typeof t?.uri === "string" && typeof t.name === "string" ? [`${t.uri}#${t.name}`] : []));
  return [...new Set(ids)].filter((id) => listed.includes(id));
}

export interface Tests {
  discover: () => Promise<void>;
  items: () => string[];
  run: (ids?: string[]) => Promise<void>;
}

const isQFile = (d: TextDocument): boolean => d.languageId === "q" && d.uri.scheme === "file" && /\.q$/i.test(d.uri.fsPath);

export function registerAffectedOnSave(
  context: ExtensionContext,
  server: () => Server | undefined,
  tests: Tests,
): { registered: () => boolean; lastRun: () => string[]; settled: () => Promise<void> } {
  const on = (): boolean => languageOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "affectedTestsOnSave");
  let listening: { listeners: Disposable[]; seen: Map<string, string> } | undefined;
  let running: Promise<void> = Promise.resolve();
  let last: string[] = [];
  const affected = async (document: TextDocument, previous: string): Promise<void> => {
    // Queued behind another run: turned off meanwhile, nothing is sent (#1086).
    const client = server();
    if (!on() || client === undefined) {
      return;
    }
    const answer = await client.sendRequest(TESTS_REACHING, { textDocument: { uri: document.uri.toString() }, previous }).catch(() => undefined);
    await tests.discover();
    const ids = affectedIds(answer, tests.items());
    last = ids;
    if (ids.length > 0 && on()) {
      window.setStatusBarMessage(`q-lint: running ${ids.length} affected test(s)`, 5000);
      await tests.run(ids);
    }
  };
  const sync = (): void => {
    if (on() && listening === undefined) {
      const seen = new Map<string, string>();
      for (const d of workspace.textDocuments.filter(isQFile)) {
        seen.set(d.uri.toString(), d.getText());
      }
      const listeners = [
        workspace.onDidOpenTextDocument((d) => isQFile(d) && !seen.has(d.uri.toString()) && void seen.set(d.uri.toString(), d.getText())),
        workspace.onDidCloseTextDocument((d) => void seen.delete(d.uri.toString())),
        workspace.onDidSaveTextDocument((d) => {
          if (!isQFile(d) || listening === undefined) {
            return;
          }
          const key = d.uri.toString();
          const previous = seen.get(key) ?? "";
          seen.set(key, d.getText());
          running = running.then(() => affected(d, previous)).catch(() => undefined);
        }),
      ];
      listening = { listeners, seen };
    } else if (!on() && listening !== undefined) {
      listening.listeners.forEach((l) => l.dispose());
      listening = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.testing.runAffectedOnSave") && sync()),
    { dispose: () => listening?.listeners.forEach((l) => l.dispose()) },
  );
  return { registered: () => listening !== undefined, lastRun: () => last, settled: () => running };
}
