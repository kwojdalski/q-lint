// What a new user is pointed at: the Help and Feedback view's links, the
// walkthrough, and the commands behind them. Free of any `vscode` import, so
// a test can hold it against `package.json`; `onboardingview.ts` is the VS
// Code around it.

const REPOSITORY = "https://github.com/kwojdalski/q-lint";

export const ONBOARDING = {
  /// The Help and Feedback view, last in the q-lint container.
  helpView: "q-lint.help",
  /// The walkthrough's id under `contributes.walkthroughs`.
  walkthrough: "getStarted",
  getStarted: "q-lint.getStarted",
  openHelpLink: "q-lint.openHelpLink",
  editTagColor: "q-lint.editTagColor",
  newNotebook: "q-lint.newNotebook",
  /// Context key: a q file has shown a finding this session.
  sawFinding: "q-lint.sawFinding",
} as const;

export interface HelpLink {
  id: string;
  label: string;
  /// A codicon name.
  icon: string;
  url: string;
  tooltip: string;
}

/// The Help and Feedback view's rows, in order. Each opens in the browser.
export const HELP_LINKS: readonly HelpLink[] = [
  {
    id: "readme",
    label: "Read the Documentation",
    icon: "book",
    url: `${REPOSITORY}/blob/master/editors/vscode/README.md`,
    tooltip: "The extension's README: linting, processes, queries, results, notebooks, TorQ and settings",
  },
  {
    id: "rules",
    label: "Rule Reference",
    icon: "checklist",
    url: `${REPOSITORY}/blob/master/docs/rules.md`,
    tooltip: "What each diagnostic code means, with examples",
  },
  {
    id: "bug",
    label: "Report a Bug",
    icon: "bug",
    url: `${REPOSITORY}/issues/new?labels=bug`,
    tooltip: "Open a new issue labelled bug on GitHub",
  },
  {
    id: "feature",
    label: "Suggest a Feature",
    icon: "lightbulb",
    url: `${REPOSITORY}/issues/new?labels=enhancement`,
    tooltip: "Open a new issue labelled enhancement on GitHub",
  },
  {
    id: "releases",
    label: "Release Notes",
    icon: "history",
    url: `${REPOSITORY}/releases`,
    tooltip: "What changed in each release",
  },
];

/// The `workbench.action.openWalkthrough` argument for the walkthrough of
/// the extension `publisher.name`.
export function walkthroughId(publisher: string, name: string): string {
  return `${publisher}.${name}#${ONBOARDING.walkthrough}`;
}
