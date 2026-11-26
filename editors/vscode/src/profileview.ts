// The function profile (#987) in the editor: **q-lint: Profile Functions on
// Process** runs the selection, or the statement at the cursor, on the
// connected process with every function of a namespace timed
// (`profile.ts` has the q), and shows the functions as a sortable table and
// the calls as a flame chart (`media/profile.js`).
//
// It changes the process for the length of the run - each function of the
// namespace is replaced by a timing wrapper and put back after - so it goes
// through `Live.runOnActive` with code the read-only guard reads as a write:
// a guarded process asks first, whatever the query. The originals are put
// back by the same lambda that replaced them, and a second message
// (`PROFILE_CLEANUP`) follows it either way, so a run that failed half way
// leaves nothing behind. Off (q-lint.query.functionProfile.enable), the
// command refuses, the panel closes and nothing is sent.
//
// As the other panels, the page loads only the extension's own files, under a
// Content-Security-Policy that allows no inline code and no network; every
// name goes in as text.
import { randomBytes } from "node:crypto";
import { Uri, ViewColumn, commands, window, workspace, type ExtensionContext, type Webview, type WebviewPanel } from "vscode";
import type { Live } from "./live";
import { PROFILE, PROFILE_CLEANUP, namespaceProblem, profileView, readProfile, type ProfileView } from "./profile";
import { statements } from "./statements";
import { TOOLING_COMMANDS, toolingOff, toolingOn } from "./toolingfeatures";
import { plainMessage } from "./history";

export const PROFILE_FUNCTIONS = TOOLING_COMMANDS.profileFunctions;

/// What a run turned off before it was sent hands back.
const OFF = Symbol("off");
const on = (): boolean => toolingOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "functionProfile");

/// What the page drew, as its script reported it: for tests.
export interface RenderedProfile {
  rows: number;
  frames: number;
  sortedBy: string;
  summary: string;
}

/// The namespace a piece of code most likely means: the first `.ns.` it
/// names that is not q's own.
export function namespaceIn(code: string): string | undefined {
  for (const m of code.matchAll(/(?:^|[^A-Za-z0-9_.`])(\.[A-Za-z][A-Za-z0-9_]*)\.[A-Za-z]/g)) {
    if (namespaceProblem(m[1]) === undefined) {
      return m[1];
    }
  }
  return undefined;
}

/// The code the guard reads for a run: a write to the namespace, which the
/// run makes whatever they do, and the statements. The write goes first:
/// code ending the script (`\`) or opening a comment (`/`) would hide what
/// came after it from the guard (#1441).
export function guardedCode(namespace: string, code: string): string {
  return `\`${namespace} set get \`${namespace}\n${code}`;
}

export function registerFunctionProfile(
  context: ExtensionContext,
  live: Live,
): { profile: (namespace?: string, code?: string) => Promise<ProfileView | string>; rendered: () => RenderedProfile | undefined; panelOpen: () => boolean } {
  const panel = new ProfilePanel(context);
  const profile = async (givenNamespace?: string, givenCode?: string): Promise<ProfileView | string> => {
    if (!on()) {
      return say(toolingOff("functionProfile"));
    }
    const file = givenCode === undefined ? window.activeTextEditor?.document.uri : undefined;
    const code = givenCode ?? (await live.codeFromEditor());
    if (code === undefined) {
      return "nothing to run";
    }
    const cut = statements(code);
    if (cut.length === 0) {
      return say("q-lint: there is no statement to profile.");
    }
    const namespace =
      givenNamespace ??
      (await window.showInputBox({
        title: "q-lint: profile the functions of which namespace?",
        prompt: "Each function directly in it is timed for this run, then put back as it was.",
        value: namespaceIn(code) ?? "",
        validateInput: (value) => namespaceProblem(value),
      }));
    if (namespace === undefined) {
      return "no namespace";
    }
    const problem = namespaceProblem(namespace);
    if (problem !== undefined) {
      return say(`q-lint: ${problem}.`);
    }
    const ns = namespace.trim();
    // The editor's code is profiled on its file's process (#2439).
    if (!(await live.toFileBinding(file))) {
      return "nothing was run";
    }
    let ran: { process: string; value: unknown } | undefined;
    try {
      ran = await live.runOnActive(guardedCode(ns, code), async (connection) => {
        // Turned off while it asked: no wrapper is installed (#1453).
        if (!on()) {
          return OFF;
        }
        try {
          return await connection.call(PROFILE, `\`${ns}`, cut);
        } finally {
          // Whatever became of it: a connection that closed cannot be asked.
          if (connection.isOpen) {
            // Though the evaluation turned direct meanwhile (#2562).
            await connection.callOwn(PROFILE_CLEANUP, 0).catch(() => undefined);
          }
        }
      }, "ask", undefined, undefined, true);
    } catch (error) {
      return say(`q-lint: the profile failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (ran === undefined) {
      return "nothing was run";
    }
    if (ran.value === OFF) {
      return say(toolingOff("functionProfile"));
    }
    let view: ProfileView;
    try {
      view = profileView(readProfile(ran.value, ns), ran.process, code);
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!on()) {
      return say(toolingOff("functionProfile"));
    }
    panel.show(view);
    return view;
  };
  context.subscriptions.push(
    commands.registerCommand(PROFILE_FUNCTIONS, (namespace?: unknown, code?: unknown) =>
      profile(typeof namespace === "string" ? namespace : undefined, typeof code === "string" ? code : undefined),
    ),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.query.functionProfile") && !on() && panel.close()),
  );
  return { profile, rendered: () => panel.rendered, panelOpen: () => panel.open };
}

function say(message: string): string {
  void window.showInformationMessage(plainMessage(message));
  return message;
}

function profileHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (name: string): string => webview.asWebviewUri(Uri.joinPath(media, name)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("profile.css")}">`,
    "<title>q-lint: profile</title></head><body>",
    `<script nonce="${nonce}" src="${file("profile.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}

class ProfilePanel {
  rendered: RenderedProfile | undefined;
  private panel: WebviewPanel | undefined;
  private shown: (ProfileView & { id: number }) | undefined;
  private count = 0;
  private readonly media: Uri;

  constructor(context: ExtensionContext) {
    this.media = Uri.joinPath(context.extensionUri, "media");
    context.subscriptions.push({ dispose: () => this.close() });
  }

  get open(): boolean {
    return this.panel !== undefined;
  }

  show(view: ProfileView): void {
    this.shown = { ...view, id: ++this.count };
    this.rendered = undefined;
    if (this.panel === undefined) {
      const panel = window.createWebviewPanel(
        "q-lint.profile",
        "q-lint: profile",
        { viewColumn: ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [this.media] },
      );
      this.panel = panel;
      panel.webview.html = profileHtml(panel.webview, this.media);
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
      });
      panel.webview.onDidReceiveMessage((message: { type?: string; id?: number; rendered?: RenderedProfile }) => {
        if (message.type === "ready") {
          this.post();
        } else if (message.type === "rendered" && message.id === this.shown?.id && message.rendered !== undefined) {
          this.rendered = message.rendered;
        }
      });
    } else {
      this.panel.reveal(undefined, true);
    }
    this.panel.title = `q-lint: profile of ${view.namespace} on ${view.process}`;
    this.post();
  }

  close(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.shown = undefined;
  }

  private post(): void {
    if (this.shown !== undefined) {
      void this.panel?.webview.postMessage({ type: "profile", ...this.shown });
    }
  }
}
