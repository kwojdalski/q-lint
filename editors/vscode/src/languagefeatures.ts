// The switches for the language and linter features of #1052-#1061: each
// has its own `enable` setting. Free of any `vscode` import, so node tests
// it. A feature turned off has its commands hidden (package.json's `when`)
// and refusing, its view, providers and listeners disposed, and sends
// nothing to any process; one the language server answers also goes to the
// server (`settings.ts`), which then answers nothing for it.
//
// Off unless asked for: running the affected tests on save, which sends
// code to a process at every save, and checking the dead code report
// against the active process, which sends a query.

export const LANGUAGE_SETTINGS = {
  functionalForm: { key: "functionalForm.enable", fallback: true, name: "Rewriting qSQL to and from functional form" },
  qsqlExplain: { key: "qsqlExplain.enable", fallback: true, name: "The qSQL explainer" },
  errorExplain: { key: "errorExplain.enable", fallback: true, name: "The q error explainer" },
  versionCheck: { key: "versionCheck.enable", fallback: true, name: "The q version check" },
  baseline: { key: "baseline.enable", fallback: true, name: "The lint baseline" },
  deadCode: { key: "deadCode.enable", fallback: true, name: "The dead code report" },
  deadCodeProcess: { key: "deadCode.checkProcess", fallback: false, name: "Checking the dead code report against the active process" },
  namespaceTree: { key: "namespaceTree.enable", fallback: true, name: "The q Namespaces view" },
  affectedTestsOnSave: { key: "testing.runAffectedOnSave.enable", fallback: false, name: "Running the affected tests on save" },
  typeLints: { key: "typeLints.enable", fallback: true, name: "The lints from inferred types" },
  sql: { key: "sql.enable", fallback: true, name: "The SQL tab for KDB-X" },
} as const;

export type LanguageFeature = keyof typeof LANGUAGE_SETTINGS;

/// The features' commands and views, here so a test without `vscode` can
/// list them.
export const LANGUAGE_COMMANDS = {
  toFunctional: "q-lint.rewriteToFunctional",
  toQsql: "q-lint.rewriteToQsql",
  explainQsql: "q-lint.explainQsql",
  explainError: "q-lint.explainError",
  writeBaseline: "q-lint.writeBaseline",
  deadCode: "q-lint.showDeadCode",
  namespacesRefresh: "q-lint.namespaces.refresh",
  namespacesOpen: "q-lint.namespaces.open",
  newSql: "q-lint.newSqlQuery",
  runSql: "q-lint.runSql",
} as const;

export const NAMESPACES_VIEW = "q-lint.namespaces";

/// Whether `feature` is on, read with `get` as the other settings are read.
/// Anything but a boolean is the default.
export function languageOn(get: <T>(key: string, fallback: T) => T, feature: LanguageFeature): boolean {
  const { key, fallback } = LANGUAGE_SETTINGS[feature];
  const value = get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}

/// What a command of a feature turned off says.
export function languageOff(feature: LanguageFeature): string {
  const { key, name } = LANGUAGE_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}
