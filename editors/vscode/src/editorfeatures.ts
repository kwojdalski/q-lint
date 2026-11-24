// The switches for the editor features that work with a q process or add to
// the editor's lists (#939, #940, #944, #945, #996, #997), and the test and
// debugging tools built on them (#979-#985), and the q editor's own
// behaviour (#1161, #1162, #1165): each has its own `enable` setting. Free of any `vscode`
// import, so node tests it. A feature turned off has its commands hidden
// (package.json's `when`) and refusing, its providers and listeners
// unregistered, and sends nothing.
//
// The live value hover, the undefined-name check and the process names in
// symbol search are off unless asked for: each would ask the connected
// process on its own, the first whenever the mouse rests on a name, the last
// whenever a workspace symbol search is typed.

export const EDITOR_SETTINGS = {
  testExplorer: { key: "testExplorer.enable", fallback: true, name: "The Test Explorer integration" },
  liveValueHover: { key: "liveValueHover.enable", fallback: false, name: "The live value hover" },
  idiomSnippets: { key: "idiomSnippets.enable", fallback: true, name: "The q idiom snippets" },
  undefinedNames: { key: "undefinedNames.enable", fallback: false, name: "The undefined-name check against the process" },
  temporalHover: { key: "temporalHover.enable", fallback: true, name: "The temporal hover and conversion" },
  pasteTable: { key: "pasteTable.enable", fallback: true, name: "Pasting spreadsheet data as a q table" },
  jsonConversion: { key: "jsonConversion.enable", fallback: true, name: "The JSON and q conversion" },
  helpPages: { key: "helpPages.enable", fallback: true, name: "The help pages for q's builtins" },
  tryExamples: { key: "tryExamples.enable", fallback: true, name: "Runnable examples in hovers" },
  cheatSheet: { key: "cheatSheet.enable", fallback: true, name: "The q cheat sheet" },
  testCoverage: { key: "testExplorer.coverage.enable", fallback: true, name: "Line coverage of q tests" },
  failedTests: { key: "testExplorer.failedTests.enable", fallback: true, name: "The failed-test diff and Re-run Failed q Tests" },
  snapshotTests: { key: "snapshotTests.enable", fallback: true, name: "Snapshot tests" },
  testStub: { key: "testStub.enable", fallback: true, name: "Generate Test Stub" },
  backtraceLinks: { key: "backtraceLinks.enable", fallback: true, name: "Clickable q backtraces" },
  logpoints: { key: "logpoints.enable", fallback: true, name: "Logpoints" },
  localsAtError: { key: "localsAtError.enable", fallback: true, name: "Capture Locals at Last Error" },
  argumentSlot: { key: "argumentSlot.enable", fallback: true, name: "The argument slot highlight" },
  processSymbols: { key: "processSymbols.enable", fallback: false, name: "Process names in workspace symbol search" },
  continuationIndent: { key: "editor.continuationIndent.enable", fallback: true, name: "The continuation indent on Enter" },
  dottedNames: { key: "editor.dottedNames.enable", fallback: true, name: "Dotted names as one word" },
  escapeAborts: { key: "query.escapeAborts.enable", fallback: true, name: "Escape aborting a running query" },
  parameterCache: { key: "editor.parameterCache.enable", fallback: true, name: "Toggle Parameter Cache" },
} as const;

export type EditorFeature = keyof typeof EDITOR_SETTINGS;

/// Whether `feature` is on, read with `get` as the other settings are read.
/// Anything but a boolean is the default.
export function editorFeatureOn(get: <T>(key: string, fallback: T) => T, feature: EditorFeature): boolean {
  const { key, fallback } = EDITOR_SETTINGS[feature];
  const value = get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}

/// What a command of a feature turned off says.
export function editorFeatureOff(feature: EditorFeature): string {
  const { key, name } = EDITOR_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}

/// The part of the language client the features ask: a request of the
/// server's own (`src/lsp/live.rs`).
export interface Server {
  sendRequest(method: string, params: unknown): Promise<unknown>;
}

/// A position in a document, as LSP writes one.
export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/// `value` as a range, when it is one.
export function asRange(value: unknown): LspRange | undefined {
  const r = value as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } | null;
  const n = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (r === null || typeof r !== "object" || !n(r.start?.line) || !n(r.start?.character) || !n(r.end?.line) || !n(r.end?.character)) {
    return undefined;
  }
  return { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } };
}
