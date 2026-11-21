// The switches for the editor features that work with a q process or add to
// the editor's lists (#939, #940, #944, #945): each has its own `enable`
// setting. Free of any `vscode` import, so node tests it. A feature turned
// off has its commands hidden (package.json's `when`) and refusing, its
// providers and listeners unregistered, and sends nothing.
//
// The live value hover and the undefined-name check are off unless asked
// for: each would ask the connected process on its own, the first whenever
// the mouse rests on a name.

export const EDITOR_SETTINGS = {
  testExplorer: { key: "testExplorer.enable", fallback: true, name: "The Test Explorer integration" },
  liveValueHover: { key: "liveValueHover.enable", fallback: false, name: "The live value hover" },
  idiomSnippets: { key: "idiomSnippets.enable", fallback: true, name: "The q idiom snippets" },
  undefinedNames: { key: "undefinedNames.enable", fallback: false, name: "The undefined-name check against the process" },
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
