// The live value hover (#940): hovering a global in a q editor shows the
// value it has on the connected process, beside the language server's hover
// (`valuehover.ts` has the q and the Markdown).
//
// Off unless q-lint.liveValueHover.enable asks for it: it asks the process
// whenever the mouse rests on a global. While it is off no hover provider
// is registered and nothing is sent. On, the language server names the
// global under the mouse - none for a local or a word of q's - and the
// value is read through `Live.borrow`, as the Process Explorer reads, so it
// never waits behind or in front of a query: a busy process shows nothing.
// A process tagged prod, prd or production is not asked.
import { Hover, MarkdownString, Range, languages, workspace, type Disposable, type ExtensionContext, type Position, type TextDocument } from "vscode";
import { isProduction } from "./agent";
import { asRange, editorFeatureOn, type Server } from "./editorfeatures";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { PREVIEW_LIMIT, VALUE_PREVIEW, previewMarkdown, previewNames, readPreview } from "./valuehover";

/// The server's request for the global at a position.
export const GLOBAL_AT = "q-lint/globalAt";
/// How long a hover waits for a query or a view's read to finish.
const WAIT = 1000;

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "liveValueHover");

/// Register the hover while q-lint.liveValueHover.enable is on. `server` is
/// the language server while it runs.
export function registerValueHover(
  context: ExtensionContext,
  live: Live,
  server: () => Server | undefined,
): { registered: () => boolean; hover: (document: TextDocument, position: Position) => Promise<Hover | undefined> } {
  let provider: Disposable | undefined;
  const hover = (document: TextDocument, position: Position) => valueHover(live, server, document, position);
  const sync = (): void => {
    if (on() && provider === undefined) {
      // VS Code shows this hover beside the language server's.
      provider = languages.registerHoverProvider({ language: "q" }, { provideHover: (d, p) => hover(d, p) });
    } else if (!on() && provider !== undefined) {
      provider.dispose();
      provider = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.liveValueHover") && sync()),
    { dispose: () => provider?.dispose() },
  );
  return { registered: () => provider !== undefined, hover };
}

async function valueHover(live: Live, server: () => Server | undefined, document: TextDocument, position: Position): Promise<Hover | undefined> {
  const process = live.activeProcess();
  const lsp = server();
  if (!on() || process === undefined || lsp === undefined) {
    return undefined;
  }
  let global: { names?: unknown; range?: unknown } | null;
  try {
    global = (await lsp.sendRequest(GLOBAL_AT, {
      textDocument: { uri: document.uri.toString() },
      position: { line: position.line, character: position.character },
    })) as { names?: unknown; range?: unknown } | null;
  } catch {
    return undefined;
  }
  const names = previewNames(Array.isArray(global?.names) ? global.names.filter((n): n is string => typeof n === "string") : []);
  if (names === "") {
    return undefined;
  }
  const at = asRange(global?.range);
  const range = at === undefined ? undefined : new Range(at.start.line, at.start.character, at.end.line, at.end.character);
  if (isProduction(process)) {
    return new Hover(new MarkdownString(`Live value not read: ${process.label.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&")} is a production process.`), range);
  }
  try {
    // Only the process checked above: not one connected meanwhile (#1456).
    const got = await borrowWhenFree(live, (connection) => connection.call(VALUE_PREVIEW, names, PREVIEW_LIMIT), WAIT, process.label);
    const markdown = got === undefined ? undefined : previewMarkdown(readPreview(got.value), process.label);
    return markdown === undefined ? undefined : new Hover(new MarkdownString(markdown), range);
  } catch {
    return undefined;
  }
}
