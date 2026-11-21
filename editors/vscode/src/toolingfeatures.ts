// The switches for the profiling and code-quality features (#986-#992):
// each has its own `enable` setting. Free of any `vscode` import, so node
// tests it. A feature turned off has its commands hidden (package.json's
// `when`) and refusing, its views, decorations and listeners disposed, and
// sends nothing to any process.
//
// Formatting only the changed lines on save is off unless asked for: it
// edits a file on its own, at every save. Line timings and the function
// profile send code, but only when their command is run, as a query does.

export const TOOLING_SETTINGS = {
  lineTimings: { key: "query.lineTimings.enable", fallback: true, name: "Line timings" },
  functionProfile: { key: "query.functionProfile.enable", fallback: true, name: "The function profile" },
  formatChangedLines: { key: "formatChangedLines.enable", fallback: false, name: "Formatting the changed lines on save" },
  organiseLoads: { key: "organiseLoads.enable", fallback: true, name: "Organise loads" },
  problemsDashboard: { key: "problemsDashboard.enable", fallback: true, name: "The problems dashboard" },
} as const;

export type ToolingFeature = keyof typeof TOOLING_SETTINGS;

/// The features' commands, here so a test without `vscode` can list them.
export const TOOLING_COMMANDS = {
  timeLines: "q-lint.timeLines",
  clearLineTimings: "q-lint.clearLineTimings",
  profileFunctions: "q-lint.profileFunctions",
  formatChangedLines: "q-lint.formatChangedLines",
  organiseLoads: "q-lint.organiseLoads",
  showProblems: "q-lint.showProblemsDashboard",
  lintHistory: "q-lint.problemsDashboard.lintHistory",
} as const;

/// Whether `feature` is on, read with `get` as the other settings are read.
/// Anything but a boolean is the default.
export function toolingOn(get: <T>(key: string, fallback: T) => T, feature: ToolingFeature): boolean {
  const { key, fallback } = TOOLING_SETTINGS[feature];
  const value = get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}

/// What a command of a feature turned off says.
export function toolingOff(feature: ToolingFeature): string {
  const { key, name } = TOOLING_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}
