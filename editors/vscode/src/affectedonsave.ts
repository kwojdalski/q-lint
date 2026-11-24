// Run the affected tests on save (#1059). When a q file is saved, the
// language server compares its top-level functions with the text this last
// saw of it and answers the tests that reach a changed one through the call
// graph (`q-lint/testsReaching`); those tests - and only those - are run by
// the Test Explorer, as its Run profile runs them: on the active connection,
// asking which process when there is none, and confirming a production one.
// One run at a time: a save while one runs waits for it. A save the server
// did not answer for, or whose run failed, is not forgotten: the next save
// of that file is compared against the text that one was (#1875).
//
// Off unless asked for (q-lint.testing.runAffectedOnSave.enable), since it
// sends code to a process at every save; off, nothing listens and nothing is
// kept. It needs the Test Explorer on (q-lint.testExplorer.enable). Its
// setting is restricted, and in a workspace that is not trusted a save
// runs nothing (#1228).
import { window, workspace, type Disposable, type ExtensionContext, type TextDocument } from "vscode";
import type { Server } from "./editorfeatures";
import { iconsEscaped } from "./history";
import { languageOn } from "./languagefeatures";
import { functionTestId } from "./testing";

export const TESTS_REACHING = "q-lint/testsReaching";

/// The Test Explorer ids of the tests the server answered, among `listed`:
/// a function test's id is its file's URI, `#`, and the name q defines it
/// by (`functionTestId`).
export function affectedIds(answer: unknown, listed: string[]): string[] {
  const a = answer as { tests?: unknown } | null | undefined;
  if (!a || !Array.isArray(a.tests)) {
    return [];
  }
  const ids = a.tests.flatMap((t: { uri?: unknown; name?: unknown; qualified?: unknown }) =>
    typeof t?.uri === "string" && typeof t.name === "string"
      ? [functionTestId(t.uri, { name: t.name, ...(typeof t.qualified === "string" ? { qualified: t.qualified } : {}) })]
      : [],
  );
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
  let listening: { listeners: Disposable[]; seen: Map<string, string | Promise<string>> } | undefined;
  let running: Promise<void> = Promise.resolve();
  let last: string[] = [];
  /// Whether the server was asked and answered; throws what the run does.
  const affected = async (document: TextDocument, previous: string): Promise<boolean> => {
    // Queued behind another run: turned off meanwhile, nothing is sent (#1086).
    // A folder that is not trusted runs nothing at a save, whatever its
    // settings say (#1228).
    const client = server();
    if (!on() || client === undefined || workspace.isTrusted === false) {
      return false;
    }
    let answer: unknown;
    try {
      answer = await client.sendRequest(TESTS_REACHING, { textDocument: { uri: document.uri.toString() }, previous });
    } catch (error) {
      // Said, not swallowed: no test ran for this save (#1875).
      window.setStatusBarMessage(
        iconsEscaped(`q-lint: could not find the tests this save affects (${error instanceof Error ? error.message : String(error)}); the next save looks again`),
        5000,
      );
      return false;
    }
    await tests.discover();
    const ids = affectedIds(answer, tests.items());
    last = ids;
    if (ids.length > 0 && on()) {
      window.setStatusBarMessage(`q-lint: running ${ids.length} affected test(s)`, 5000);
      await tests.run(ids);
    }
    return true;
  };
  const sync = (): void => {
    if (on() && listening === undefined) {
      const seen = new Map<string, string | Promise<string>>();
      // The text a save that ran nothing was compared against, by file: its
      // changes are still to be tested, so the next save's are added to them.
      const owed = new Map<string, string>();
      // A document already edited when listening starts compares against
      // its file on disk: its buffer holds edits no save has run tests for.
      const baseline = (d: TextDocument): string | Promise<string> =>
        d.isDirty
          ? Promise.resolve(workspace.fs.readFile(d.uri)).then(
              (bytes) => new TextDecoder().decode(bytes),
              () => "",
            )
          : d.getText();
      for (const d of workspace.textDocuments.filter(isQFile)) {
        seen.set(d.uri.toString(), baseline(d));
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
          running = running
            .then(async () => {
              const since = owed.get(key) ?? (await previous);
              owed.set(key, since);
              if (await affected(d, since)) {
                owed.delete(key);
              }
            })
            .catch(() => undefined);
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
