// The problems dashboard (#992): **q-lint: Show Problems Dashboard** lints a
// workspace folder with `qlinter --format json` - the command line's
// reading, as CI sees it - and draws its findings by rule and by folder, and
// their trend over commits (`problems.ts`). Each refresh on a commit whose q
// files are unchanged adds that commit to the trend, kept in the workspace's
// state; **Lint Earlier Commits** adds the last ones from git. Every point
// is of a commit written out from an index of its own and linted apart, never checked
// out: the commit's files, not the q files git ignores in the folder. Nothing is sent to
// a q process. Off (q-lint.problemsDashboard.enable), the panel closes and
// the commands refuse.
//
// As the other panels, the page loads only the extension's own files, under a
// Content-Security-Policy that allows no inline code and no network; every
// name goes in as text.
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { ProgressLocation, Uri, ViewColumn, commands, window, workspace, type ExtensionContext, type Webview, type WebviewPanel } from "vscode";
import { head, history, lintCommit, lintTree, pointOf, readTrend, summarise, withPoint, type DashboardView, type Point } from "./problems";
import { TOOLING_COMMANDS, toolingOff, toolingOn } from "./toolingfeatures";
import { plainMessage } from "./history";

export const SHOW_PROBLEMS = TOOLING_COMMANDS.showProblems;
export const LINT_HISTORY = TOOLING_COMMANDS.lintHistory;

const on = (): boolean => toolingOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "problemsDashboard");

const trendKey = (folder: string): string => `q-lint.problemsTrend:${folder}`;

/// What the page drew, as its script reported it: for tests.
export interface RenderedDashboard {
  total: number;
  rules: number;
  folders: number;
  points: number;
}

/// `qlinter` and the arguments the dashboard runs it with: the profile and
/// configuration file the settings name, as the server is started with. No
/// command where none is configured, bundled or on PATH.
export type Linter = () => { command: string | undefined; args: string[] };

const NO_QLINTER = "q-lint: no qlinter to run: set q-lint.serverPath, or put qlinter on PATH.";

export function registerProblemsDashboard(
  context: ExtensionContext,
  linter: Linter,
): {
  show: (folder?: string) => Promise<DashboardView | string>;
  lintHistory: (count?: number, folder?: string) => Promise<DashboardView | string>;
  rendered: () => RenderedDashboard | undefined;
  panelOpen: () => boolean;
} {
  const panel = new DashboardPanel(context);
  const folderPath = async (given?: string): Promise<string | undefined> => {
    if (given !== undefined) {
      return given;
    }
    // Folders on disk: a virtual one (a remote repository) is no directory
    // for qlinter to run in, as Write Lint Baseline skips one too (#1843).
    const folders = (workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
    if (folders.length <= 1) {
      return folders[0]?.uri.fsPath;
    }
    const picked = await window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath })),
      { title: "q-lint: the problems of which folder?" },
    );
    return picked?.description;
  };
  const trend = (folder: string): Point[] => readTrend(context.workspaceState.get(trendKey(folder), []));
  const show = async (given?: string): Promise<DashboardView | string> => {
    if (!on()) {
      return say(toolingOff("problemsDashboard"));
    }
    const folder = await folderPath(given);
    if (folder === undefined) {
      return say("q-lint: open a folder first: the dashboard lints a workspace folder.");
    }
    const { command, args } = linter();
    if (command === undefined) {
      return say(NO_QLINTER);
    }
    let view: DashboardView;
    try {
      const findings = await lintTree(command, args, folder);
      // No trend from git in a workspace that is not trusted: git reads the
      // repository's configuration, which can name programs to run.
      const at = workspace.isTrusted === false ? undefined : await head(folder);
      let points = trend(folder);
      // The commit's point is of the commit, as an earlier one's is: the
      // folder may hold q files git ignores, which no commit has (#1896).
      if (at !== undefined && at.clean && !points.some((p) => p.commit === at.commit)) {
        points = withPoint(points, pointOf(await lintCommit(command, args, folder, at.commit), at.commit, at.date, at.subject));
        await context.workspaceState.update(trendKey(folder), points);
      }
      view = {
        folder,
        at: new Date().toISOString(),
        ...(at !== undefined ? { commit: at.commit } : {}),
        clean: at?.clean ?? false,
        summary: summarise(findings, [folder, realFolder(folder)]),
        trend: points,
      };
    } catch (error) {
      return say(`q-lint: the problems dashboard could not lint ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!on()) {
      return say(toolingOff("problemsDashboard"));
    }
    panel.show(view, { refresh: () => void show(folder), history: () => void lintHistory(undefined, folder) });
    return view;
  };
  const lintHistory = async (givenCount?: number, given?: string): Promise<DashboardView | string> => {
    if (!on()) {
      return say(toolingOff("problemsDashboard"));
    }
    const folder = await folderPath(given);
    if (folder === undefined) {
      return say("q-lint: open a folder first: the dashboard lints a workspace folder.");
    }
    if (workspace.isTrusted === false) {
      return say("q-lint: linting earlier commits asks git for them, which is not done in a workspace that is not trusted.");
    }
    let count = givenCount;
    if (count === undefined) {
      const picked = await window.showQuickPick(["5", "10", "20", "50"], { title: "q-lint: lint how many of the latest commits?" });
      count = picked === undefined ? undefined : Number(picked);
    }
    if (count === undefined || !Number.isInteger(count) || count < 1) {
      return "no count";
    }
    const { command, args } = linter();
    if (command === undefined) {
      return say(NO_QLINTER);
    }
    try {
      const commits = await history(folder, count);
      let points = trend(folder);
      const known = new Set(points.map((p) => p.commit));
      const todo = commits.filter((c) => !known.has(c.commit));
      await window.withProgress({ location: ProgressLocation.Notification, title: "q-lint: linting earlier commits", cancellable: true }, async (progress, token) => {
        for (const [i, c] of todo.entries()) {
          if (token.isCancellationRequested || !on()) {
            break;
          }
          progress.report({ message: `${i + 1} of ${todo.length}: ${c.subject}`, increment: 100 / todo.length });
          points = withPoint(points, pointOf(await lintCommit(command, args, folder, c.commit), c.commit, c.date, c.subject));
          await context.workspaceState.update(trendKey(folder), points);
        }
      });
    } catch (error) {
      return say(`q-lint: could not lint the earlier commits: ${error instanceof Error ? error.message : String(error)}`);
    }
    return show(folder);
  };
  context.subscriptions.push(
    commands.registerCommand(SHOW_PROBLEMS, (folder?: unknown) => show(typeof folder === "string" ? folder : undefined)),
    commands.registerCommand(LINT_HISTORY, (count?: unknown, folder?: unknown) =>
      lintHistory(typeof count === "number" ? count : undefined, typeof folder === "string" ? folder : undefined),
    ),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.problemsDashboard") && !on() && panel.close()),
  );
  return { show, lintHistory, rendered: () => panel.rendered, panelOpen: () => panel.open };
}

function say(message: string): string {
  void window.showInformationMessage(plainMessage(message));
  return message;
}

function dashboardHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (name: string): string => webview.asWebviewUri(Uri.joinPath(media, name)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("problems.css")}">`,
    "<title>q-lint: problems</title></head><body>",
    `<script nonce="${nonce}" src="${file("problems.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}

class DashboardPanel {
  rendered: RenderedDashboard | undefined;
  private panel: WebviewPanel | undefined;
  private shown: (DashboardView & { id: number }) | undefined;
  private actions: { refresh: () => void; history: () => void } | undefined;
  private count = 0;
  private readonly media: Uri;

  constructor(context: ExtensionContext) {
    this.media = Uri.joinPath(context.extensionUri, "media");
    context.subscriptions.push({ dispose: () => this.close() });
  }

  get open(): boolean {
    return this.panel !== undefined;
  }

  show(view: DashboardView, actions: { refresh: () => void; history: () => void }): void {
    this.shown = { ...view, id: ++this.count };
    this.actions = actions;
    this.rendered = undefined;
    if (this.panel === undefined) {
      const panel = window.createWebviewPanel(
        "q-lint.problems",
        "q-lint: problems",
        { viewColumn: ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [this.media] },
      );
      this.panel = panel;
      panel.webview.html = dashboardHtml(panel.webview, this.media);
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
      });
      panel.webview.onDidReceiveMessage((message: { type?: string; id?: number; rendered?: RenderedDashboard }) => {
        if (message.type === "ready") {
          this.post();
        } else if (message.type === "rendered" && message.id === this.shown?.id && message.rendered !== undefined) {
          this.rendered = message.rendered;
        } else if (message.type === "refresh") {
          this.actions?.refresh();
        } else if (message.type === "history") {
          this.actions?.history();
        }
      });
    } else {
      this.panel.reveal(undefined, true);
    }
    this.post();
  }

  close(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.shown = undefined;
  }

  private post(): void {
    if (this.shown !== undefined) {
      void this.panel?.webview.postMessage({ type: "problems", ...this.shown });
    }
  }
}

/// `folder` with its symlinks resolved, as qlinter names the files in it;
/// itself where that cannot be read.
function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}
