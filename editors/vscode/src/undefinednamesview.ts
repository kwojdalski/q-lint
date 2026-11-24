// The undefined-name check against the process (#945): a warning on each
// global a q file reads that neither the workspace nor the connected process
// defines (`undefinednames.ts` has the q).
//
// Off unless q-lint.undefinedNames.enable asks for it, since it asks the
// process on its own. On, the active q file is checked when it is opened,
// saved or brought to the front, when a connection opens, and after a query
// (which may have defined names); always through `Live.borrow`, so a check
// never waits behind or in front of a query - a busy process is checked
// next time. A process tagged prod, prd or production is checked only by
// **Check Undefined Names on Process**, after a confirmation. Disconnecting
// clears the warnings, since what they say was about that process. Off,
// they are cleared, nothing is registered or sent, and the command refuses.
import {
  Diagnostic,
  DiagnosticSeverity,
  Range,
  commands,
  languages,
  window,
  workspace,
  type DiagnosticCollection,
  type ExtensionContext,
  type TextDocument,
} from "vscode";
import { isProduction } from "./agent";
import { editorFeatureOff, editorFeatureOn, type Server } from "./editorfeatures";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { CHECK_UNDEFINED, DEFINED, namesToAsk, readDefined, readUnresolved, undefinedMessage, undefinedOnProcess } from "./undefinednames";
import { plainMessage } from "./history";

export { CHECK_UNDEFINED };
/// The server's request for the globals no workspace file defines.
export const UNRESOLVED = "q-lint/unresolvedNames";
/// What the warnings' source says.
export const SOURCE = "q-lint (process)";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "undefinedNames");

const isQFile = (document: TextDocument): boolean => document.languageId === "q" && document.uri.scheme === "file" && /\.q$/i.test(document.uri.fsPath);

/// Register the check while q-lint.undefinedNames.enable is on, and its
/// command always. `server` is the language server while it runs.
export function registerUndefinedNames(
  context: ExtensionContext,
  live: Live,
  server: () => Server | undefined,
): { registered: () => boolean; check: (document: TextDocument, asked: boolean) => Promise<string | undefined>; collection: () => DiagnosticCollection | undefined } {
  let running: Checker | undefined;
  const sync = (): void => {
    if (on() && running === undefined) {
      running = new Checker(live, server);
    } else if (!on() && running !== undefined) {
      running.dispose();
      running = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    commands.registerCommand(CHECK_UNDEFINED, async () => {
      if (!on() || running === undefined) {
        void window.showInformationMessage(plainMessage(editorFeatureOff("undefinedNames")));
        return undefined;
      }
      const document = window.activeTextEditor?.document;
      if (document === undefined || !isQFile(document)) {
        void window.showInformationMessage("q-lint: Check Undefined Names on Process checks a saved .q file; open one first.");
        return undefined;
      }
      const problem = await running.check(document, true);
      if (problem !== undefined) {
        void window.showInformationMessage(plainMessage(`q-lint: ${problem}`));
      }
      return problem;
    }),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.undefinedNames") && sync()),
    { dispose: () => running?.dispose() },
  );
  return {
    registered: () => running !== undefined,
    check: async (document, asked) => running?.check(document, asked) ?? editorFeatureOff("undefinedNames"),
    collection: () => running?.collection,
  };
}

class Checker {
  readonly collection: DiagnosticCollection;
  private readonly disposables: { dispose(): unknown }[];
  private disposed = false;

  constructor(
    private readonly live: Live,
    private readonly server: () => Server | undefined,
  ) {
    this.collection = languages.createDiagnosticCollection("q-lint-process");
    const active = (): void => {
      const document = window.activeTextEditor?.document;
      if (document !== undefined && isQFile(document)) {
        void this.check(document, false);
      }
    };
    this.disposables = [
      this.collection,
      workspace.onDidOpenTextDocument((document) => isQFile(document) && void this.check(document, false)),
      workspace.onDidSaveTextDocument((document) => isQFile(document) && void this.check(document, false)),
      workspace.onDidCloseTextDocument((document) => this.collection.delete(document.uri)),
      window.onDidChangeActiveTextEditor(() => active()),
      live.onDidChange((what) => {
        if (what === "disconnected") {
          this.collection.clear();
        } else {
          active();
        }
      }),
    ];
    active();
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /// Check `document`: undefined once done, or why it was not. `asked` by
  /// the command, which waits for a busy process a little and confirms a
  /// production one; otherwise a busy or production process is skipped.
  async check(document: TextDocument, asked: boolean): Promise<string | undefined> {
    const process = this.live.activeProcess();
    if (process === undefined) {
      this.collection.delete(document.uri);
      return "connect to a q process first: the check asks it which names it defines.";
    }
    const lsp = this.server();
    if (lsp === undefined) {
      return "the language server is not running, and it finds the names the workspace does not define.";
    }
    if (isProduction(process)) {
      if (!asked) {
        return `${process.label} is a production process, checked only when asked.`;
      }
      const go = "Check";
      const answer = await window.showWarningMessage(
        plainMessage(`${process.label} is a production process (tagged ${process.tags.join(", ")}). Ask it which of this file's names it defines?`),
        { modal: true, detail: "It reads each name's namespace with key; nothing is evaluated or changed." },
        go,
      );
      if (answer !== go) {
        return "not checked.";
      }
    }
    let found;
    try {
      found = readUnresolved(await lsp.sendRequest(UNRESOLVED, { textDocument: { uri: document.uri.toString() } }));
    } catch (error) {
      return `the language server could not list the names: ${error instanceof Error ? error.message : String(error)}`;
    }
    const names = namesToAsk(found);
    let defined = new Map<string, boolean>();
    if (names.length > 0) {
      try {
        // Only the process checked (and asked about) above (#1456).
        const got = await borrowWhenFree(this.live, (connection) => connection.call(DEFINED, names.join(" ")), asked ? 3000 : 0, process.label);
        if (got === undefined) {
          return `a query is running on ${process.label}; the file is checked when it is done.`;
        }
        defined = readDefined(got.value, names);
      } catch (error) {
        return `${process.label} could not be asked: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    // Still on, and still connected to the process asked: else what came
    // back is about another.
    if (this.disposed || this.live.activeLabel() !== process.label) {
      return undefined;
    }
    this.collection.set(
      document.uri,
      undefinedOnProcess(found, defined).map((u) => {
        const diagnostic = new Diagnostic(
          new Range(u.range.start.line, u.range.start.character, u.range.end.line, u.range.end.character),
          undefinedMessage(u, process.label),
          DiagnosticSeverity.Warning,
        );
        diagnostic.source = SOURCE;
        return diagnostic;
      }),
    );
    return undefined;
  }
}
