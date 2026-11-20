// The VS Code around `onboarding.ts`: the Help and Feedback view, **Get
// Started**, **New q Notebook**, and **Edit Tag Color** on a Processes row.
import {
  commands,
  ConfigurationTarget,
  env,
  languages,
  NotebookCellData,
  NotebookCellKind,
  NotebookData,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  window,
  workspace,
  type ExtensionContext,
  type QuickPickItem,
  type TreeDataProvider,
} from "vscode";
import { HELP_LINKS, ONBOARDING, walkthroughId, type HelpLink } from "./onboarding";
import { TAG_COLOURS, tagColour, tagColourTarget, tagColours, withTagColour, type Process } from "./processes";
import { readProcessSettings } from "./liveconfig";
import { NOTEBOOK } from "./qnb";

const TAG_COLOURS_KEY = "processes.tagColors";

class HelpView implements TreeDataProvider<HelpLink> {
  getChildren(link?: HelpLink): HelpLink[] {
    return link === undefined ? [...HELP_LINKS] : [];
  }

  getTreeItem(link: HelpLink): TreeItem {
    const item = new TreeItem(link.label, TreeItemCollapsibleState.None);
    item.iconPath = new ThemeIcon(link.icon);
    item.tooltip = `${link.tooltip}\n${link.url}`;
    item.contextValue = "helpLink";
    item.command = { command: ONBOARDING.openHelpLink, title: link.label, arguments: [link.id] };
    return item;
  }
}

/// A tag row of the Processes view, a tag's name, or nothing - then the
/// user picks one of the tags in use.
type TagArg = { kind: "tag"; tag: string } | string | undefined;

export function registerOnboarding(context: ExtensionContext, processes: () => Process[]): void {
  const c = (name: string, run: (...args: never[]) => unknown) => commands.registerCommand(name, run);
  const { publisher, name } = context.extension.packageJSON as { publisher: string; name: string };
  context.subscriptions.push(
    window.registerTreeDataProvider(ONBOARDING.helpView, new HelpView()),
    c(ONBOARDING.getStarted, () =>
      commands.executeCommand("workbench.action.openWalkthrough", walkthroughId(publisher, name), false),
    ),
    c(ONBOARDING.openHelpLink, (which?: string) => openHelpLink(which)),
    c(ONBOARDING.editTagColor, (tag?: TagArg) => editTagColour(tag, processes)),
    c(ONBOARDING.newNotebook, () => newNotebook()),
  );
  // The walkthrough's first step is done once a q file shows a finding. A
  // walkthrough sees only global context keys, and a document's language is
  // not one, so this sets its own. VS Code counts the key only when it turns
  // true while the walkthrough is loaded; opening the Problems view, the
  // step's other event, covers the rest.
  const sawFinding = (): boolean =>
    workspace.textDocuments.some((d) => d.languageId === "q" && languages.getDiagnostics(d.uri).length > 0);
  if (sawFinding()) {
    void commands.executeCommand("setContext", ONBOARDING.sawFinding, true);
  } else {
    const listening = languages.onDidChangeDiagnostics(() => {
      if (sawFinding()) {
        void commands.executeCommand("setContext", ONBOARDING.sawFinding, true);
        listening.dispose();
      }
    });
    context.subscriptions.push(listening);
  }
}

/// Open a Help and Feedback link, named by its id or its URL, or picked.
async function openHelpLink(which?: string): Promise<boolean> {
  const link =
    HELP_LINKS.find((l) => l.id === which || l.url === which) ??
    (which === undefined
      ? (
          await window.showQuickPick(
            HELP_LINKS.map((l) => ({ label: `$(${l.icon}) ${l.label}`, detail: l.tooltip, link: l })),
            { title: "q-lint: Help and Feedback" },
          )
        )?.link
      : undefined);
  return link === undefined ? false : env.openExternal(Uri.parse(link.url, true));
}

async function editTagColour(arg: TagArg, processes: () => Process[]): Promise<void> {
  let tag = typeof arg === "string" ? arg : arg?.tag;
  if (tag === undefined) {
    const tags = [...new Set(processes().flatMap((p) => p.tags))].sort();
    if (tags.length === 0) {
      void window.showInformationMessage("q-lint: no process has a tag yet. Tag Process gives one some.");
      return;
    }
    tag = await window.showQuickPick(tags, { title: "Edit the colour of which tag?" });
    if (tag === undefined) {
      return;
    }
  }
  tag = tag.trim().toLowerCase();
  const configuration = workspace.getConfiguration("q-lint");
  const inspected = configuration.inspect<unknown>(TAG_COLOURS_KEY);
  const target = tagColourTarget(inspected);
  const current = readProcessSettings((key, fallback) => configuration.get(key, fallback)).tagColors[tag];
  const builtIn = tagColour(tag);
  const items: (QuickPickItem & { colour: string | undefined })[] = [
    {
      label: "$(circle-outline) default",
      description: builtIn === undefined ? "no colour" : `built in: ${builtIn}`,
      colour: undefined,
    },
    ...TAG_COLOURS.map((colour) => ({
      label: colour,
      iconPath: new ThemeIcon("circle-filled", new ThemeColor(colour)),
      colour,
    })),
  ];
  for (const item of items) {
    if (item.colour === current) {
      item.description = [item.description, "current"].filter(Boolean).join(", ");
    }
  }
  const where =
    target === "workspace"
      ? "Saved to the workspace settings, which already set q-lint.processes.tagColors and would hide a user setting."
      : "Saved to your user settings, where the process list is kept too, so the colour follows the tag into every workspace.";
  const picked = await window.showQuickPick(items, {
    title: `Colour of the tag ${tag}`,
    placeHolder: where,
  });
  if (picked === undefined) {
    return;
  }
  // VS Code merges an object setting across levels, so going back to the
  // default clears the tag at both: one left at the other would still show.
  const levels =
    picked.colour === undefined ? (["user", "workspace"] as const) : ([target] as const);
  for (const level of levels) {
    const value = level === "workspace" ? inspected?.workspaceValue : inspected?.globalValue;
    if (picked.colour === undefined && !(tag in tagColours(value))) {
      continue;
    }
    const next = withTagColour(tagColours(value), tag, picked.colour);
    await configuration.update(
      TAG_COLOURS_KEY,
      Object.keys(next).length === 0 ? undefined : next,
      level === "workspace" ? ConfigurationTarget.Workspace : ConfigurationTarget.Global,
    );
  }
}

/// An untitled q notebook with one cell to run.
async function newNotebook(): Promise<void> {
  const cell = new NotebookCellData(NotebookCellKind.Code, "til 10", "q");
  const document = await workspace.openNotebookDocument(NOTEBOOK.type, new NotebookData([cell]));
  await window.showNotebookDocument(document);
}
