// The q Namespaces view (#1058): every global the workspace defines, grouped
// by namespace - `.` first, then `.ns`, `.ns.sub` - from the language
// server's index (`q-lint/definitions`), each opening its definition. It
// reads again when shown, when a q file is saved, when the server restarts
// and on Refresh. Off (q-lint.namespaceTree.enable), the view is hidden and
// its tree, listeners and requests disposed. Nothing is sent to a q process.
import {
  EventEmitter,
  Range,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  commands,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import type { Server } from "./editorfeatures";
import { LANGUAGE_COMMANDS, NAMESPACES_VIEW, languageOff, languageOn } from "./languagefeatures";

export const DEFINITIONS = "q-lint/definitions";

export interface Definition {
  name: string;
  namespace: string;
  kind: "function" | "variable";
  uri: string;
  line: number;
  character: number;
}

/// The server's answer as definitions; anything unreadable is dropped.
export function readDefinitions(answer: unknown): Definition[] {
  if (!Array.isArray(answer)) {
    return [];
  }
  return answer.flatMap((d: { name?: unknown; namespace?: unknown; kind?: unknown; uri?: unknown; range?: { start?: { line?: unknown; character?: unknown } } }) =>
    typeof d?.name === "string" &&
    typeof d.namespace === "string" &&
    typeof d.uri === "string" &&
    typeof d.range?.start?.line === "number" &&
    typeof d.range.start.character === "number"
      ? [{ name: d.name, namespace: d.namespace, kind: d.kind === "function" ? "function" : "variable", uri: d.uri, line: d.range.start.line, character: d.range.start.character }]
      : [],
  );
}

/// Definitions grouped by namespace, the root first and the rest in order.
export function byNamespace(definitions: Definition[]): [string, Definition[]][] {
  const groups = new Map<string, Definition[]>();
  for (const d of definitions) {
    groups.set(d.namespace, [...(groups.get(d.namespace) ?? []), d]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "." ? -1 : b === "." ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([ns, ds]) => [ns, ds.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.uri < y.uri ? -1 : 1))]);
}

type Node = { namespace: string; count: number } | Definition;

class Namespaces implements TreeDataProvider<Node> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  groups: [string, Definition[]][] = [];

  constructor(private readonly server: () => Server | undefined) {}

  async read(): Promise<void> {
    const client = this.server();
    this.groups = client === undefined ? [] : byNamespace(readDefinitions(await client.sendRequest(DEFINITIONS, {}).catch(() => [])));
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (node === undefined) {
      return this.groups.map(([namespace, ds]) => ({ namespace, count: ds.length }));
    }
    return "count" in node ? (this.groups.find(([ns]) => ns === node.namespace)?.[1] ?? []) : [];
  }

  getTreeItem(node: Node): TreeItem {
    if ("count" in node) {
      const item = new TreeItem(node.namespace, node.namespace === "." ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed);
      item.description = `${node.count}`;
      item.iconPath = new ThemeIcon("symbol-namespace");
      return item;
    }
    const leaf = node.namespace === "." ? node.name : node.name.slice(node.namespace.length + 1);
    const item = new TreeItem(leaf, TreeItemCollapsibleState.None);
    item.description = workspace.asRelativePath(Uri.parse(node.uri));
    item.tooltip = `${node.name} - ${node.kind}, line ${node.line + 1}`;
    item.iconPath = new ThemeIcon(node.kind === "function" ? "symbol-function" : "symbol-variable");
    item.command = { command: LANGUAGE_COMMANDS.namespacesOpen, title: "Go to Definition", arguments: [node] };
    return item;
  }
}

export function registerNamespaces(
  context: ExtensionContext,
  server: () => Server | undefined,
): { registered: () => boolean; groups: () => [string, Definition[]][]; refresh: () => Promise<void>; serverChanged: () => void } {
  const on = (): boolean => languageOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "namespaceTree");
  let shown: { provider: Namespaces; view: TreeView<Node>; listeners: Disposable[] } | undefined;
  const sync = (): void => {
    if (on() && shown === undefined) {
      const provider = new Namespaces(server);
      const view = window.createTreeView(NAMESPACES_VIEW, { treeDataProvider: provider, showCollapseAll: true });
      const listeners = [
        view.onDidChangeVisibility((e) => e.visible && void provider.read()),
        workspace.onDidSaveTextDocument((d) => d.languageId === "q" && view.visible && void provider.read()),
      ];
      shown = { provider, view, listeners };
      if (view.visible) {
        void provider.read();
      }
    } else if (!on() && shown !== undefined) {
      shown.listeners.forEach((l) => l.dispose());
      shown.view.dispose();
      shown = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    commands.registerCommand(LANGUAGE_COMMANDS.namespacesRefresh, async () => {
      if (shown === undefined) {
        void window.showInformationMessage(languageOff("namespaceTree"));
        return;
      }
      await shown.provider.read();
    }),
    commands.registerCommand(LANGUAGE_COMMANDS.namespacesOpen, async (d?: Definition) => {
      if (shown === undefined) {
        void window.showInformationMessage(languageOff("namespaceTree"));
        return;
      }
      if (d === undefined || typeof d.uri !== "string") {
        return;
      }
      const at = new Range(d.line, d.character, d.line, d.character);
      await window.showTextDocument(Uri.parse(d.uri), { selection: at });
    }),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.namespaceTree") && sync()),
    { dispose: () => (shown?.listeners.forEach((l) => l.dispose()), shown?.view.dispose()) },
  );
  return {
    registered: () => shown !== undefined,
    groups: () => shown?.provider.groups ?? [],
    refresh: async () => shown?.provider.read(),
    serverChanged: () => void (shown?.view.visible && shown.provider.read()),
  };
}
