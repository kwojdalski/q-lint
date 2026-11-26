// The Notebook Variables view (#946): the globals in the root namespace of
// the process the active q notebook's cells ran on, each with its type,
// count and size (`notebookvars.ts`). Read through `Live.borrow`, as the
// Process Explorer reads, so it never waits behind or in front of a query:
// it reads when a cell has run, when another notebook becomes active, when a
// connection opens or closes, and on Refresh, and only while the view is on
// show.
import {
  EventEmitter,
  MarkdownString,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type NotebookDocument,
  type TreeDataProvider,
} from "vscode";
import type { Live } from "./live";
import { bytesText, describeVariable, kindText, readVariables, VARIABLE_LIMIT, VARS, type Variable } from "./notebookvars";
import { featureOn, featureSetting, requireFeature } from "./notebook";
import { NOTEBOOK } from "./qnb";

/// Set while the active editor is a q notebook: the view shows then, and
/// Restart and Run All is in the palette.
export const NOTEBOOK_ACTIVE = "q-lint.notebookActive";

const icon = (v: Variable): string =>
  v.type === 98 || v.type === 99 ? "symbol-class" : v.type >= 100 ? "symbol-method" : v.type < 0 ? "symbol-constant" : "symbol-array";

class VariablesView implements TreeDataProvider<Variable> {
  private variables: Variable[] = [];
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  set(variables: Variable[]): void {
    this.variables = variables;
    this.changed.fire();
  }

  rows(): Variable[] {
    return this.variables;
  }

  getChildren(element?: Variable): Variable[] {
    return element === undefined ? this.variables : [];
  }

  getTreeItem(v: Variable): TreeItem {
    const item = new TreeItem(v.name, TreeItemCollapsibleState.None);
    item.description = describeVariable(v);
    item.iconPath = new ThemeIcon(icon(v));
    const tip = new MarkdownString();
    tip.appendMarkdown(`**${v.name.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&")}**\n\n`);
    tip.appendText(`${kindText(v.type, v.view)} (type ${v.type})`);
    if (v.count !== undefined) {
      tip.appendText(`, count ${v.count.toLocaleString("en")}`);
    }
    if (v.size !== undefined) {
      tip.appendText(`, ${bytesText(v.size)} serialized`);
    }
    item.tooltip = tip;
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/// The active editor's notebook when it is a q notebook.
const active = (): NotebookDocument | undefined => {
  const notebook = window.activeNotebookEditor?.notebook;
  return notebook?.notebookType === NOTEBOOK.type ? notebook : undefined;
};

/// Register the view and its Refresh, while `q-lint.notebook.variables.enable`
/// is on: off, the view is disposed and nothing is read, and Refresh says
/// so. `processOf` names the process a notebook's cells last ran on;
/// `onDidRun` fires when one has run.
export function registerNotebookVariables(
  context: ExtensionContext,
  live: Live,
  processOf: (notebook: NotebookDocument) => string | undefined,
  onDidRun: (listener: (notebook: NotebookDocument) => void) => { dispose(): void },
): { variables: () => Variable[]; message: () => string | undefined; refresh: () => Promise<void>; registered: () => boolean } {
  let running: ReturnType<typeof startView> | undefined;
  const sync = (): void => {
    if (featureOn("variables") && running === undefined) {
      running = startView(live, processOf, onDidRun);
    } else if (!featureOn("variables") && running !== undefined) {
      running.dispose();
      running = undefined;
    }
  };
  sync();
  // Kept whether or not the view is on: Restart and Run All's palette entry
  // reads it too (#1402).
  const setContext = (): void => void commands.executeCommand("setContext", NOTEBOOK_ACTIVE, active() !== undefined);
  setContext();
  context.subscriptions.push(
    window.onDidChangeActiveNotebookEditor(() => setContext()),
    commands.registerCommand(NOTEBOOK.refreshVariables, async () => {
      if (requireFeature("variables")) {
        await running?.refreshNow();
      }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(featureSetting("variables"))) {
        sync();
      }
    }),
    { dispose: () => running?.dispose() },
  );
  return {
    variables: () => running?.provider.rows() ?? [],
    message: () => running?.view.message,
    refresh: async () => running?.refreshNow(),
    registered: () => running !== undefined,
  };
}

/// The view and what refreshes it, until disposed.
function startView(
  live: Live,
  processOf: (notebook: NotebookDocument) => string | undefined,
  onDidRun: (listener: (notebook: NotebookDocument) => void) => { dispose(): void },
) {
  const provider = new VariablesView();
  const view = window.createTreeView(NOTEBOOK.variablesView, { treeDataProvider: provider });
  const show = (variables: Variable[], message?: string, description?: string): void => {
    provider.set(variables);
    view.message = message;
    view.description = description;
  };
  let reading: Promise<void> | undefined;
  /// A refresh asked for while one was reading, made when it ends (#1952).
  let again = false;
  let disposed = false;
  /// A refresh put off by a running query, made when it is done (#1077).
  let deferred = false;
  const refresh = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    const notebook = active();
    if (notebook === undefined) {
      show([], "Open a q notebook to see the globals its cells define.");
      return;
    }
    const label = processOf(notebook);
    if (label === undefined) {
      show([], "Run a cell of this notebook to see the globals on its process.");
      return;
    }
    if (live.activeLabel() !== label) {
      show([], `This notebook's cells ran on ${label}, which is not the active connection. Run a cell to connect again.`, label);
      return;
    }
    const read = live.borrow((connection) => connection.call(VARS, VARIABLE_LIMIT));
    if (read === undefined) {
      // A query is running: what it defines is read when it is done.
      view.message = `A query is running on ${label}; the view refreshes when it is done.`;
      deferred = true;
      return;
    }
    // Shown only while its notebook is still the one in view: another's
    // globals are not this one's (#1952).
    const current = (): boolean => !disposed && active() === notebook;
    try {
      const { variables, total } = readVariables(await read);
      if (!current()) {
        return;
      }
      show(
        variables,
        variables.length === 0 ? `No globals in the root namespace of ${label}.` : total > variables.length ? `The first ${variables.length} of ${total} globals.` : undefined,
        label,
      );
    } catch (error) {
      if (current()) {
        show([], `Could not read the globals on ${label}: ${error instanceof Error ? error.message : String(error)}`, label);
      }
    }
  };
  /// Refresh, once at a time, and only while the view is on show. One asked
  /// for during a read is made after it: the read may be of another
  /// notebook, or from before the cell that asked ran.
  const whenShown = (): void => {
    if (!view.visible) {
      return;
    }
    if (reading !== undefined) {
      again = true;
      return;
    }
    reading = refresh().finally(() => {
      reading = undefined;
      if (again) {
        again = false;
        whenShown();
      }
    });
  };
  const disposables = [
    provider,
    view,
    onDidRun((notebook) => {
      if (notebook === active()) {
        whenShown();
      }
    }),
    window.onDidChangeActiveNotebookEditor(() => whenShown()),
    view.onDidChangeVisibility(() => whenShown()),
    live.onDidChange((what) => {
      // "connected": to the notebook's process again, or to another (#1953).
      if (what === "connected" || what === "disconnected" || (what === "queried" && deferred)) {
        deferred = false;
        whenShown();
      }
    }),
    // Put off for a background read, the heartbeat's, which no event ends (#3020).
    live.onDidFree(() => {
      if (deferred) {
        deferred = false;
        whenShown();
      }
    }),
  ];
  return {
    provider,
    view,
    refreshNow: async (): Promise<void> => {
      await reading;
      await refresh();
    },
    dispose: (): void => {
      disposed = true;
      disposables.forEach((d) => d.dispose());
    },
  };
}
