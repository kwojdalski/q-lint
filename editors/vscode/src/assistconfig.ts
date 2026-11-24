// The switches for drift detection (#933), hot reload (#934), the query
// (#1624), schema and lint agent tools (#951), the @q chat participant (#952) and English
// to qSQL (#953): each has its own `enable` setting. Free of any `vscode`
// import, so node tests it. A feature turned off has its commands hidden
// (package.json's `when`) and refusing, its listener, tool or participant
// unregistered, and sends nothing.
//
// Drift detection and hot reload are off unless asked for: hot reload sends
// code to a process on every save, and drift detection reads every function
// the workspace defines from the process.

export const ASSIST_SETTINGS = {
  drift: { key: "processExplorer.driftDetection.enable", fallback: false, name: "Drift detection" },
  hotReload: { key: "hotReload.enable", fallback: false, name: "Hot reload on save" },
  queryTool: { key: "agent.queryTool.enable", fallback: true, name: "The Run q Query agent tool" },
  schemaTool: { key: "agent.schemaTool.enable", fallback: true, name: "The List q Tables agent tool" },
  lintTool: { key: "agent.lintTool.enable", fallback: true, name: "The Lint q Code agent tool" },
  chat: { key: "chat.participant.enable", fallback: true, name: "The @q chat participant" },
  qsql: { key: "chat.englishToQsql.enable", fallback: true, name: "Draft qSQL from a Description" },
} as const;

export type AssistFeature = keyof typeof ASSIST_SETTINGS;

/// The features whose settings are listed with the queries' and with the
/// agents' in package.json.
export const QUERY_FEATURES = ["drift", "hotReload"] as const;
export const AGENT_FEATURES = ["queryTool", "schemaTool", "lintTool", "chat", "qsql"] as const;

/// Which features are on, read with `get` as `readExplorer` reads its
/// settings. Anything but a boolean is the default.
/// `only` reads just those features' settings, and leaves the rest false.
export function readAssist(get: <T>(key: string, fallback: T) => T, only?: readonly AssistFeature[]): Record<AssistFeature, boolean> {
  const out = { drift: false, hotReload: false, queryTool: false, schemaTool: false, lintTool: false, chat: false, qsql: false } as Record<AssistFeature, boolean>;
  for (const [feature, { key, fallback }] of Object.entries(ASSIST_SETTINGS)) {
    if (only !== undefined && !only.includes(feature as AssistFeature)) {
      continue;
    }
    const value = get<unknown>(key, fallback);
    out[feature as AssistFeature] = typeof value === "boolean" ? value : fallback;
  }
  return out;
}

/// What a command of a feature turned off says.
export function assistOff(feature: AssistFeature): string {
  const { key, name } = ASSIST_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}
