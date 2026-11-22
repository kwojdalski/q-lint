// The switches for the database features (#1022-#1031): each has its own
// `enable` setting. Free of any `vscode` import, so node tests it. A feature
// turned off has its commands hidden (package.json's `when`) and refusing,
// its panels closed, its timers stopped, and sends nothing to any process.
//
// Every one is on by default: each acts only when its command is run. The
// two that change something - the HDB column manager, and the tickerplant
// log's replay - show what they will do and ask first; a dashboard tile is
// refreshed on its own only when given an interval of its own.

export const DB_SETTINGS = {
  columnManager: { key: "hdbBrowser.columnManager.enable", fallback: true, name: "The HDB column manager" },
  documenter: { key: "databaseDocumenter.enable", fallback: true, name: "The database documenter" },
  partitionCheck: { key: "hdbBrowser.partitionCheck.enable", fallback: true, name: "The partition consistency check" },
  symInspector: { key: "hdbBrowser.symInspector.enable", fallback: true, name: "The sym file inspector" },
  attributeAdvisor: { key: "processExplorer.attributeAdvisor.enable", fallback: true, name: "The attribute advisor" },
  schemaMigration: { key: "schemaMigration.enable", fallback: true, name: "Schema migration" },
  testData: { key: "testDataGenerator.enable", fallback: true, name: "The test data generator" },
  chartCli: { key: "charts.commandLine.enable", fallback: true, name: "Charts from a file" },
} as const;

export type DbFeature = keyof typeof DB_SETTINGS;

/// The features' commands, here so a test without `vscode` can list them.
export const DB_COMMANDS = {
  manageColumn: "q-lint.manageHdbColumn",
  document: "q-lint.documentDatabase",
  checkPartitions: "q-lint.checkPartitions",
  inspectSym: "q-lint.inspectSymFile",
  adviseAttributes: "q-lint.adviseAttributes",
  migrateSchema: "q-lint.writeSchemaMigration",
  testData: "q-lint.generateTestData",
  renderChart: "q-lint.renderChartFromFile",
} as const;

/// Whether `feature` is on, read with `get` as the other settings are read.
/// Anything but a boolean is the default.
export function dbOn(get: <T>(key: string, fallback: T) => T, feature: DbFeature): boolean {
  const { key, fallback } = DB_SETTINGS[feature];
  const value = get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}

/// What a command of a feature turned off says.
export function dbOff(feature: DbFeature): string {
  const { key, name } = DB_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}
