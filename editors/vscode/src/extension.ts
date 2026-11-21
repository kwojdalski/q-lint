// The whole VS Code integration: launch `qlinter --lsp` and let the protocol
// do the rest.
//
// Everything a reader might expect here - reading files, parsing output,
// building diagnostics, deciding when to re-lint - lives in the server, which
// is why this stays short. The settings are mapped to the server's command
// line and options in `settings.ts`. The same server serves Neovim, Helix
// and Zed with a comparable amount of their own configuration; nothing in this
// file is knowledge those editors would have to reimplement.
import {
  commands,
  Uri,
  workspace,
  window,
  type ExtensionContext,
  type OutputChannel,
} from "vscode";
import { LINTED, launch, needsRestart } from "./settings";
import { Live } from "./live";
import { registerAgentTool } from "./agenttool";
import { registerOnboarding } from "./onboardingview";
import { registerNotebooks, type RenderedChart, type RenderedLiveValue } from "./notebook";
import { runWithParameters } from "./notebookrun";
import { registerNotebookVariables } from "./notebookvarsview";
import { NOTEBOOK } from "./qnb";
import { ProcessExplorer } from "./explorerview";
import { Relations } from "./relate";
import { Serial } from "./serial";
import { FunctionSources } from "./funcsourceview";
import { registerInfoViews } from "./infoview";
import { QueryAcross } from "./queryacross";
import { SavedQueries } from "./savedqueriesview";
import { TableStreams } from "./streamview";
import { Launcher } from "./launcherview";
import type { InfoNode } from "./monitor";
import { registerTestExplorer } from "./testexplorer";
import { registerValueHover } from "./valuehoverview";
import { registerUndefinedNames } from "./undefinednamesview";
import { registerIdioms } from "./idiomsview";
import { Drift } from "./driftview";
import { registerAssistTools } from "./assisttools";
import { registerChat } from "./chat";
import { registerQsqlDraft } from "./qsqldraft";
import { Interpreters } from "./interpreterview";
import { registerTasks } from "./taskprovider";
import { registerDevContainer } from "./devcontainerview";
import { registerInteractive } from "./interactiveview";
import { registerRepl } from "./replview";
import { registerViewHelpers } from "./viewhelpers";
import { ResultTools } from "./resulttools";
import { SchemaTools } from "./schemaview";
import { registerTemporal } from "./temporalview";
import { registerPaste } from "./pasteview";
import { registerHelp } from "./helpview";
import { registerCheatSheet } from "./cheatsheetview";
import { PlotsView } from "./plotsview";
import { PLOTS } from "./plots";
import { registerSnapshots } from "./snapshotview";
import { registerTestStubs } from "./teststubview";
import { registerBacktraceLinks } from "./backtraceview";
import { registerLogpoints } from "./logpointview";
import { registerLocalsAtError } from "./localsview";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  type ErrorHandler,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
/// The command a code lens of the server runs (`src/lsp/annotate.rs`).
export const RUN_DEFINITION = "q-lint.runDefinition";
/// How long a server has to answer `initialize`. qlinter answers it at once
/// - the workspace is indexed after - so one still silent by then is hung,
/// and every restart would otherwise queue behind it for good.
export const timing = { start: 20_000 };
/// Every start, restart and stop of `client`, one at a time.
const serial = new Serial();
/// One channel for the life of the extension. Each client would otherwise
/// make its own, and every restart would leave another "q-lint" in the
/// Output panel's list.
let channel: OutputChannel | undefined;
/// The dependencies view and the affected-tests list, which ask whichever
/// `client` is running and are told when it changes.
let relations: Relations | undefined;
/// The Test Explorer integration, which asks the running `client` for the
/// tests and is told when it changes.
let testExplorer: ReturnType<typeof registerTestExplorer> | undefined;

/// The server's requests, while one runs.
const running = () => (client?.isRunning() ? client : undefined);

/// Tell what asks the server that it changed.
function serverChanged(): void {
  relations?.serverChanged();
  testExplorer?.serverChanged();
}

/// The server this extension was packaged with, if it was packaged with one.
///
/// A platform-specific build carries the matching `qlinter` in `server/`, so
/// the extension works with nothing installed and nothing configured - which
/// is the whole point, since the commonest failure by far was a binary that
/// was never on PATH. The platform-neutral build carries none, and falls back
/// to the setting. An explicit `q-lint.serverPath` always wins: someone who
/// named a binary meant that one.
function bundledServer(context: ExtensionContext): string | undefined {
  const name = process.platform === "win32" ? "qlinter.exe" : "qlinter";
  const path = join(context.extensionPath, "server", name);
  if (!existsSync(path)) {
    return undefined;
  }
  // A .vsix is a zip, and the unix executable bit does not reliably survive
  // the round trip. Restoring it here is cheaper than the support thread that
  // starts with EACCES.
  if (process.platform !== "win32" && !(statSync(path).mode & 0o111)) {
    try {
      chmodSync(path, 0o755);
    } catch {
      // Fall through: the spawn below will report it better than we can.
    }
  }
  return path;
}

export async function activate(
  context: ExtensionContext,
): Promise<
  ReturnType<Live["api"]> & {
    explorer: ProcessExplorer["rows"];
    notebookCharts: () => RenderedChart[];
    agentConfirmation: ReturnType<typeof registerAgentTool>;
    notebookLiveValues: () => RenderedLiveValue[];
    notebookVariables: ReturnType<typeof registerNotebookVariables>;
    processMonitor: () => InfoNode[];
    hdbBrowser: () => InfoNode[];
    functionSources: FunctionSources["state"];
    queryAcross: QueryAcross["state"];
    savedQueries: SavedQueries["queries"];
    tableStreams: TableStreams["state"];
    launchedProcesses: Launcher["running"];
    testExplorer: Omit<ReturnType<typeof registerTestExplorer>, "serverChanged">;
    valueHover: ReturnType<typeof registerValueHover>;
    undefinedNames: ReturnType<typeof registerUndefinedNames>;
    idioms: ReturnType<typeof registerIdioms>;
    hotReload: Drift["hotReloadState"];
    assistTools: () => string[];
    chatParticipant: () => boolean;
    interpreter: { status: () => string | undefined };
    qTasks: () => boolean;
    interactive: ReturnType<typeof registerInteractive>;
    repl: ReturnType<typeof registerRepl>;
    viewHelpers: ReturnType<typeof registerViewHelpers>;
    schemaDiagram: SchemaTools["state"];
    temporal: ReturnType<typeof registerTemporal>;
    help: ReturnType<typeof registerHelp>;
    cheatSheet: ReturnType<typeof registerCheatSheet>;
    plots: { registered: () => boolean; list: () => readonly { kind: string; process: string; code: string; svg: string }[]; current: () => number };
    testStubs: ReturnType<typeof registerTestStubs>;
    backtraceLinks: ReturnType<typeof registerBacktraceLinks>;
    logpoints: ReturnType<typeof registerLogpoints>;
    localsAtError: ReturnType<typeof registerLocalsAtError>;
  }
> {
  // Replacing the binary does not restart the server, and a window reload is
  // a blunt way to pick up a new one. This is the small way.
  context.subscriptions.push(commands.registerCommand("q-lint.restartServer", () => restart(context, true)));
  // The server reads its settings once, at startup, so a change starts a new
  // one - except the trace level, which the client applies as it runs.
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (needsRestart((section) => event.affectsConfiguration(section))) {
        void restart(context);
      }
    }),
  );
  context.subscriptions.push({ dispose: () => void stop() });
  // The q processes, queries and their history: in the editor only, and
  // started before the server so they work when it does not.
  const live = new Live(context);
  // The server's Run and Run test lenses hand over the code to send and the
  // document it is from; it goes as a query from that editor would.
  context.subscriptions.push(
    commands.registerCommand(RUN_DEFINITION, (code?: unknown, uri?: unknown) => {
      // A lens drawn before the setting was turned off can still be clicked.
      if (workspace.getConfiguration("q-lint").get<unknown>("codeLens.enable", true) === false) {
        void window.showInformationMessage(
          "q-lint: the Run code lenses are turned off (q-lint.codeLens.enable); turn the setting on to run a definition from its lens.",
        );
        return undefined;
      }
      return typeof code === "string" && typeof uri === "string" ? live.queryCode(code, Uri.parse(uri)) : undefined;
    }),
  );
  const agentConfirmation = registerAgentTool(context, live);
  const notebook = registerNotebooks(context, live);
  const notebookVariables = registerNotebookVariables(context, live, notebook.processOf, notebook.onDidRun);
  context.subscriptions.push(
    commands.registerCommand(NOTEBOOK.runWithParameters, (source?: Uri, target?: Uri, overrides?: Record<string, string>) =>
      runWithParameters(live, source, target, overrides),
    ),
  );
  const explorer = new ProcessExplorer(context, live);
  const sources = new FunctionSources(context, live);
  const infoViews = registerInfoViews(context, live);
  const across = new QueryAcross(context, live);
  const saved = new SavedQueries(context, live);
  const drift = new Drift(context, live);
  // The tools' qlinter is the one the server is started from.
  const assistTools = registerAssistTools(context, live, () => {
    const { serverPath } = launch(workspace.getConfiguration("q-lint"), workspace.workspaceFolders?.[0]?.uri.fsPath);
    return serverPath ? [serverPath] : [bundledServer(context), "qlinter"].filter((c): c is string => !!c);
  });
  const chatParticipant = registerChat(context, live);
  registerQsqlDraft(context, live);
  const repl = registerRepl(context, live);
  const interactive = registerInteractive(context, live, repl);
  const viewHelpers = registerViewHelpers(context, live);
  registerOnboarding(context, () => live.processes());
  const streams = new TableStreams(context, live);
  const launcher = new Launcher(context, live);
  relations = new Relations(context, () => client);
  testExplorer = registerTestExplorer(context, live, running);
  const valueHover = registerValueHover(context, live, running);
  const undefinedNames = registerUndefinedNames(context, live, running);
  const idioms = registerIdioms(context);
  const interpreters = new Interpreters(context);
  const qTasks = registerTasks(context);
  registerDevContainer(context);
  new ResultTools(context, live);
  const schema = new SchemaTools(context, live);
  const temporal = registerTemporal(context);
  registerPaste(context, live);
  const help = registerHelp(context, live);
  const cheatSheet = registerCheatSheet(context);
  const plots = new PlotsView(context);
  registerSnapshots(context, live, () => void testExplorer?.discover());
  const testStubs = registerTestStubs(context);
  const backtraceLinks = registerBacktraceLinks(context);
  const logpoints = registerLogpoints(context, live);
  const localsAtError = registerLocalsAtError(context, live);
  // Not awaited: nothing above needs the server, and a slow or hung one
  // would hold up every command of the extension until it answered.
  void serial.run(() => start(context)).then(() => serverChanged());
  return {
    ...live.api(),
    explorer: () => explorer.rows(),
    notebookCharts: () => notebook.charts(),
    agentConfirmation,
    notebookLiveValues: () => notebook.liveValues(),
    notebookVariables,
    processMonitor: infoViews.monitor,
    hdbBrowser: infoViews.hdb,
    functionSources: () => sources.state(),
    queryAcross: () => across.state(),
    savedQueries: () => saved.queries(),
    tableStreams: () => streams.state(),
    launchedProcesses: () => launcher.running(),
    testExplorer: {
      discover: testExplorer.discover,
      items: testExplorer.items,
      results: testExplorer.results,
      run: testExplorer.run,
      coverage: testExplorer.coverage,
      profiles: testExplorer.profiles,
    },
    valueHover,
    undefinedNames,
    idioms,
    hotReload: () => drift.hotReloadState(),
    assistTools: assistTools.registered,
    chatParticipant: chatParticipant.registered,
    interpreter: { status: () => interpreters.status() },
    qTasks: qTasks.registered,
    interactive,
    repl,
    viewHelpers,
    schemaDiagram: () => schema.state(),
    temporal,
    help,
    cheatSheet,
    plots: { registered: () => plots.registered(), list: () => PLOTS.list(), current: () => PLOTS.current },
    testStubs,
    backtraceLinks,
    logpoints,
    localsAtError,
  };
}

/// Stop the server and start it again. `asked`: by Restart Server, which
/// says so when the setting leaves it off rather than doing nothing.
function restart(context: ExtensionContext, asked = false): Promise<void> {
  return serial.run(async () => {
    await client?.stop().catch(() => {});
    client = undefined;
    await start(context);
    serverChanged();
    if (asked && client === undefined && workspace.getConfiguration("q-lint").get<unknown>("enable", true) === false) {
      void window.showInformationMessage("q-lint: the language server is turned off (q-lint.enable), so Restart Server started none.");
    }
  });
}

/// Whether `command --version` runs and succeeds.
function answersVersion(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore", timeout: 10_000, windowsHide: true }).status === 0;
}

function stop(): Promise<void> {
  return serial.run(async () => {
    await client?.stop().catch(() => {});
    client = undefined;
    serverChanged();
  });
}

async function start(context: ExtensionContext): Promise<void> {
  const settings = launch(
    workspace.getConfiguration("q-lint"),
    workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
  if (!settings.enabled) {
    return;
  }
  const configured = settings.serverPath;
  if (channel === undefined) {
    channel = window.createOutputChannel("q-lint");
    context.subscriptions.push(channel);
  }

  // In order of preference, and the fallback matters: packaging the extension
  // from a clone on Linux picks up the darwin-arm64 binary checked in for
  // local macOS builds, and preferring a server that cannot execute would be
  // worse than not bundling one at all. If the bundled one will not start,
  // PATH still gets its turn before the user sees an error.
  const candidates = configured
    ? [configured]
    : [bundledServer(context), "qlinter"].filter((c): c is string => !!c);

  const args = settings.args;
  const options: LanguageClientOptions = {
    initializationOptions: settings.initializationOptions,
    // A saved `.q` file, and nothing else: see LINTED.
    documentSelector: LINTED,
    // The output channel the server's own trace goes to, so a user debugging
    // the integration has one place to look.
    outputChannel: channel,
    // No `synchronize`: the server asks for the files it has to hear about
    // itself - the workspace's `.q` and `.toml` files, and the configuration
    // it read from outside the workspace, which no pattern here could name
    // in advance - so every editor gets them, not only this one (#554).
  };

  let started: unknown;
  for (const [i, command] of candidates.entries()) {
    // The language client reports a server it cannot start with an error of
    // its own, so a candidate with another after it is asked its version
    // first: a bundled binary built for another platform then falls through
    // to PATH without a false alarm. The last is left to the client, which
    // says why it failed - and a wrapper script need not know --version.
    if (i < candidates.length - 1 && !answersVersion(command)) {
      started = new Error(`${command} --version did not run`);
      continue;
    }
    const server: ServerOptions = {
      // One entry, used for both: this server has no separate debug mode, and
      // giving it a fabricated one would mean a second thing to keep in step.
      //
      // No `transport` field. stdio is already the default for an executable,
      // and naming it explicitly makes the client append `--stdio` to argv -
      // a flag qlinter does not accept, so it exits 2 before the handshake.
      run: { command, args },
      debug: { command, args },
    };
    // A server given up on must not be restarted by its own client when it
    // is killed: the default handler restarts a server that closes.
    let abandoned = false;
    let fallback: ErrorHandler | undefined;
    const errorHandler: ErrorHandler = {
      error: (error, message, count) =>
        abandoned || fallback === undefined
          ? { action: ErrorAction.Shutdown, handled: true }
          : fallback.error(error, message, count),
      closed: () =>
        abandoned || fallback === undefined ? { action: CloseAction.DoNotRestart, handled: true } : fallback.closed(),
    };
    client = new LanguageClient("q-lint", "q-lint", server, { ...options, errorHandler });
    fallback = client.createDefaultErrorHandler();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true;
            reject(new Error(`${command} did not answer initialize within ${timing.start / 1000} s.`));
          }, timing.start);
        }),
      ]);
      clearTimeout(timer);
      started = undefined;
      // Which server answered, and where it came from. The rules live in the
      // binary, so a diagnostic that looks wrong is often a diagnostic from a
      // server older than the one the user thinks they installed - and until
      // this line there was no way to tell from inside the editor.
      const version = client.initializeResult?.serverInfo?.version ?? "unknown version";
      client.outputChannel.appendLine(`q-lint ${version} from ${command}`);
      break;
    } catch (error) {
      clearTimeout(timer);
      started = error;
      // A client still starting refuses to stop, but its server is killed
      // all the same once the attempt settles.
      await client.stop().catch(() => {});
      client = undefined;
    }
  }

  {
    const error = started;
    const command = candidates.join('", "');
    if (client === undefined && configured) {
      // The user named this binary, so the advice is about that setting -
      // not to install one and set it, which they did.
      window.showErrorMessage(
        `q-lint: could not start "${configured}", the binary q-lint.serverPath names. ` +
          `Check the path, or clear the setting to use the server bundled with the extension. ${error}`,
      );
    } else if (client === undefined) {
      // Name every binary that was tried. "Couldn't start the server" sends
      // someone to the logs; saying what was attempted, and that none of them
      // ran, tells them what to fix.
      window.showErrorMessage(
        `q-lint: could not start "${command}". No server for ${process.platform}-` +
          `${process.arch} would run: install a release archive from ` +
          `github.com/kwojdalski/q-lint/releases and set q-lint.serverPath to the qlinter ` +
          `binary, or put it on PATH. ${error}`,
      );
    }
  }
}

export function deactivate(): Thenable<void> {
  return stop();
}
