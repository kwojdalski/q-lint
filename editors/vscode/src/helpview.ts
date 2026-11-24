// Show Help (#971) and the runnable examples in hovers (#972).
//
// Show Help opens a page for a builtin beside the editor: its syntax, what
// it gives, examples with their results, related builtins and its page in
// the KX reference. The page is a webview of escaped HTML with no script,
// under a policy that allows only the extension's stylesheet; its links are
// `command:` links to this file's two commands and nothing else.
//
// Hovering a builtin that has examples adds them to the hover, each with a
// Try it link. Clicking one is the only way an example is sent: it goes to
// the connected process through `Live.run`, as a query from the editor, so
// the read-only guard (#918) holds one that would change a guarded process.
// q-lint.helpPages.enable switches the pages off, q-lint.tryExamples.enable
// the hover and Try it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commands,
  Hover,
  MarkdownString,
  Range,
  Uri,
  ViewColumn,
  languages,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type Position,
  type TextDocument,
  type WebviewPanel,
} from "vscode";
import { editorFeatureOff, editorFeatureOn, type EditorFeature } from "./editorfeatures";
import { commentedOut, examplesMarkdown, HELP, html, HelpCatalog, nameAt, pageHtml } from "./helpcatalog";
import type { Live } from "./live";
import { plainMessage } from "./history";

const on = (feature: EditorFeature): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), feature);

export interface HelpApi {
  /// Whether the examples hover is registered.
  hoverRegistered: () => boolean;
  hover: (document: TextDocument, position: Position) => Hover | undefined;
  /// The builtin the help page shows, and its HTML, while it is open.
  shown: () => { name: string; html: string } | undefined;
  catalog: () => HelpCatalog;
}

/// Register Show Help, Try Example, and the examples hover while
/// q-lint.tryExamples.enable is on.
export function registerHelp(context: ExtensionContext, live: Live): HelpApi {
  let catalog: HelpCatalog | undefined;
  const load = (): HelpCatalog =>
    (catalog ??= new HelpCatalog(
      readFileSync(join(context.extensionPath, "help", "builtins.json"), "utf8"),
      readFileSync(join(context.extensionPath, "help", "examples.json"), "utf8"),
    ));
  let panel: WebviewPanel | undefined;
  let shown: { name: string; html: string } | undefined;

  // The name at `position`, or none in a comment or a string - a block
  // comment's lines included, which only the lines above it tell.
  const nameUnder = (document: TextDocument, position: Position): ReturnType<typeof nameAt> => {
    const above = Array.from({ length: position.line + 1 }, (_, i) => document.lineAt(i).text);
    return commentedOut(above) ? undefined : nameAt(above[position.line], position.character);
  };

  const hover = (document: TextDocument, position: Position): Hover | undefined => {
    if (!on("tryExamples")) {
      return undefined;
    }
    const at = nameUnder(document, position);
    const examples = at === undefined ? [] : load().examples(at.name);
    if (at === undefined || examples.length === 0) {
      return undefined;
    }
    const markdown = new MarkdownString(examplesMarkdown(at.name, examples, HELP.tryExample, on("helpPages") ? HELP.show : undefined));
    markdown.isTrusted = { enabledCommands: [HELP.tryExample, HELP.show] };
    return new Hover(markdown, new Range(position.line, at.start, position.line, at.end));
  };

  const render = (name: string): void => {
    const page = load().page(name);
    if (page === undefined) {
      return;
    }
    const body = pageHtml(page, HELP.show, on("tryExamples") ? HELP.tryExample : undefined);
    if (panel === undefined) {
      const media = Uri.joinPath(context.extensionUri, "media");
      panel = window.createWebviewPanel("q-lint.help", "q Help", { viewColumn: ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: false,
        enableCommandUris: [HELP.show, HELP.tryExample],
        localResourceRoots: [media],
      });
      panel.onDidDispose(() => {
        panel = undefined;
        shown = undefined;
      });
    }
    const webview = panel.webview;
    const css = webview.asWebviewUri(Uri.joinPath(context.extensionUri, "media", "help.css"));
    panel.title = `q Help: ${name}`;
    webview.html = [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource};">`,
      `<link rel="stylesheet" href="${html(String(css))}">`,
      `<title>q Help: ${html(name)}</title></head><body>`,
      body,
      "</body></html>",
    ].join("\n");
    shown = { name, html: body };
    panel.reveal(ViewColumn.Beside, true);
  };

  const show = async (given?: unknown): Promise<string | undefined> => {
    if (!on("helpPages")) {
      void window.showInformationMessage(plainMessage(editorFeatureOff("helpPages")));
      return undefined;
    }
    let name = typeof given === "string" ? given : undefined;
    if (name === undefined) {
      const editor = window.activeTextEditor;
      const at = editor === undefined ? undefined : nameUnder(editor.document, editor.selection.active);
      name = at !== undefined && load().has(at.name) ? at.name : undefined;
    }
    if (name === undefined) {
      const picked = await window.showQuickPick(
        load()
          .names()
          .map((n) => {
            const p = load().page(n);
            return { label: n, description: p?.syntax, detail: p?.summary };
          }),
        { title: "q-lint: show help for", matchOnDescription: true, matchOnDetail: true },
      );
      name = picked?.label;
    }
    if (name === undefined) {
      return undefined;
    }
    if (!load().has(name)) {
      void window.showInformationMessage(plainMessage(`q-lint: ${name} is not one of q's builtins, so it has no help page.`));
      return undefined;
    }
    render(name);
    return name;
  };

  let provider: Disposable | undefined;
  const sync = (): void => {
    if (on("tryExamples") && provider === undefined) {
      provider = languages.registerHoverProvider({ language: "q" }, { provideHover: (d, p) => hover(d, p) });
    } else if (!on("tryExamples") && provider !== undefined) {
      provider.dispose();
      provider = undefined;
    }
    // An open page loses or gains its Try it links, or closes.
    if (panel !== undefined && shown !== undefined) {
      if (on("helpPages")) {
        render(shown.name);
      } else {
        panel.dispose();
      }
    }
  };
  sync();
  context.subscriptions.push(
    commands.registerCommand(HELP.show, show),
    commands.registerCommand(HELP.tryExample, async (code?: unknown) => {
      if (!on("tryExamples")) {
        void window.showInformationMessage(plainMessage(editorFeatureOff("tryExamples")));
        return false;
      }
      if (typeof code !== "string" || code.trim() === "") {
        return false;
      }
      await live.run(code);
      return true;
    }),
    workspace.onDidChangeConfiguration((event) => (event.affectsConfiguration("q-lint.tryExamples") || event.affectsConfiguration("q-lint.helpPages")) && sync()),
    { dispose: () => provider?.dispose() },
    { dispose: () => panel?.dispose() },
  );
  return { hoverRegistered: () => provider !== undefined, hover, shown: () => shown, catalog: load };
}
