// The switches for the process-insight features (#929-#932, #935): each
// has its own `enable` setting. Free of any `vscode` import, so node tests
// it. A feature turned off has its view hidden (package.json's `when`), its
// provider unregistered, its command refusing, and sends nothing.
//
// The editor's table hover is off unless asked for: it would ask the
// process for a table's details whenever the mouse rests on its name.

export const INSIGHT_SETTINGS = {
  functionSource: { key: "processExplorer.functionSource.enable", fallback: true, name: "Function source and Redefine" },
  findCallers: { key: "processExplorer.findCallers.enable", fallback: true, name: "Find Callers in Process" },
  tableHover: { key: "processExplorer.tableHover.enable", fallback: true, name: "The Process Explorer's table hover" },
  editorTableHover: { key: "processExplorer.editorTableHover.enable", fallback: false, name: "The editor's table hover" },
  processMonitor: { key: "processMonitor.enable", fallback: true, name: "The Process Monitor" },
  hdbBrowser: { key: "hdbBrowser.enable", fallback: true, name: "The HDB Browser" },
} as const;

export type InsightFeature = keyof typeof INSIGHT_SETTINGS;

/// Which features are on, read with `get` as `readExplorer` reads its
/// settings. Anything but a boolean is the default.
export function readInsight(get: <T>(key: string, fallback: T) => T): Record<InsightFeature, boolean> {
  const out = {} as Record<InsightFeature, boolean>;
  for (const [feature, { key, fallback }] of Object.entries(INSIGHT_SETTINGS)) {
    const value = get<unknown>(key, fallback);
    out[feature as InsightFeature] = typeof value === "boolean" ? value : fallback;
  }
  return out;
}

/// What a command of a feature turned off says.
export function turnedOff(feature: InsightFeature): string {
  const { key, name } = INSIGHT_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}
