// The q Cheat Sheet view (#973): iterators, joins, temporal casts and
// attributes, each a row that inserts its form at the cursor of the editor
// last used when chosen. Its tooltip shows an example and what it gives,
// which test/help_q.test.js runs on a real q. From `help/cheatsheet.json`
// (`helpcatalog.ts` reads it).
//
// Nothing is sent to a process. With q-lint.cheatSheet.enable off the view
// is hidden, its tree is disposed and the insert command refuses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commands,
  EventEmitter,
  MarkdownString,
  TreeItem,
  TreeItemCollapsibleState,
  window,
  workspace,
  type ExtensionContext,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import { editorFeatureOff, editorFeatureOn } from "./editorfeatures";
import { CHEAT_SHEET, readCheatSheet, type CheatItem, type CheatSection } from "./helpcatalog";
import { plainMessage } from "./history";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "cheatSheet");

type Row = CheatSection | CheatItem;
const isSection = (row: Row): row is CheatSection => "section" in row;

class Sheet implements TreeDataProvider<Row> {
  readonly changed = new EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(readonly sections: CheatSection[]) {}

  getChildren(row?: Row): Row[] {
    return row === undefined ? this.sections : isSection(row) ? row.items : [];
  }

  getTreeItem(row: Row): TreeItem {
    if (isSection(row)) {
      return new TreeItem(row.section, TreeItemCollapsibleState.Expanded);
    }
    const item = new TreeItem(row.label, TreeItemCollapsibleState.None);
    item.description = row.insert;
    const tip = new MarkdownString().appendText(`${row.description}\n\n`).appendCodeblock(row.insert, "q");
    if (row.example !== undefined && row.result !== undefined) {
      tip.appendText("For example\n").appendCodeblock(row.example, "q").appendText("gives\n").appendCodeblock(row.result, "q");
    }
    item.tooltip = tip;
    item.command = { command: CHEAT_SHEET.insert, title: "Insert", arguments: [row] };
    item.contextValue = "cheatSheetEntry";
    return item;
  }
}

/// Register the view while q-lint.cheatSheet.enable is on, and its commands.
export function registerCheatSheet(context: ExtensionContext): { view: () => TreeView<Row> | undefined; sections: () => CheatSection[] } {
  let sections: CheatSection[] | undefined;
  const load = (): CheatSection[] => (sections ??= readCheatSheet(readFileSync(join(context.extensionPath, "help", "cheatsheet.json"), "utf8")));
  let view: TreeView<Row> | undefined;
  const sync = (): void => {
    if (on() && view === undefined) {
      view = window.createTreeView(CHEAT_SHEET.view, { treeDataProvider: new Sheet(load()) });
    } else if (!on() && view !== undefined) {
      view.dispose();
      view = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    commands.registerCommand(CHEAT_SHEET.insert, async (row?: CheatItem | string): Promise<string | undefined> => {
      if (!on()) {
        void window.showInformationMessage(plainMessage(editorFeatureOff("cheatSheet")));
        return undefined;
      }
      // By its label, from a keybinding or a test.
      const item = typeof row === "string" ? load().flatMap((s) => s.items).find((i) => i.label === row) : row;
      if (item === undefined || typeof item.insert !== "string") {
        return undefined;
      }
      const editor = window.activeTextEditor;
      if (editor === undefined) {
        void window.showInformationMessage("q-lint: the cheat sheet inserts into an editor; open one first.");
        return undefined;
      }
      const done = await editor.edit((edit) => {
        for (const selection of editor.selections) {
          edit.replace(selection, item.insert);
        }
      });
      return done ? item.insert : undefined;
    }),
    commands.registerCommand(CHEAT_SHEET.show, async () => {
      if (!on()) {
        void window.showInformationMessage(plainMessage(editorFeatureOff("cheatSheet")));
        return;
      }
      await commands.executeCommand(`${CHEAT_SHEET.view}.focus`);
    }),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.cheatSheet") && sync()),
    { dispose: () => view?.dispose() },
  );
  return { view: () => view, sections: load };
}
