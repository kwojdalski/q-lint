// Run File with Arguments (#1005): a quick pick of the argument sets saved
// for the active file, or a new one - the words q reads as `.z.x`, and lines
// typed into q's console once it starts - then the file runs in its q
// terminal exactly as Run Code from Terminal runs it, with them added. The
// sets are kept per workspace, newest first; nothing runs but on the pick.
import { commands, window, workspace, type ExtensionContext, type QuickPickItem, type TextDocument } from "vscode";
import { clickedEditor } from "./clicked";
import {
  RUN_ARGS_COMMAND,
  RUN_ARGS_KEY,
  RUN_ARGS_OFF,
  describe,
  extraOf,
  givenSet,
  readRunArgs,
  setsFor,
  withSet,
  withoutSet,
  type ArgSet,
  type RunExtra,
} from "./runargs";

type Item = QuickPickItem & { set?: ArgSet; action?: "new" | "forget" };

export class RunWithArguments {
  constructor(
    private readonly context: ExtensionContext,
    private readonly run: (extra: RunExtra, document?: TextDocument) => Promise<void>,
  ) {
    context.subscriptions.push(commands.registerCommand(RUN_ARGS_COMMAND, (given?: unknown) => this.pick(given)));
  }

  /// Ask for a set - or take `given`, a keybinding's argument - and run the
  /// active file with it - or the file of `given`, the Uri a title-bar
  /// button hands in (#1523); the set run, for tests.
  async pick(given?: unknown): Promise<ArgSet | undefined> {
    const configuration = workspace.getConfiguration("q-lint");
    if (!readRunArgs((key, fallback) => configuration.get(key, fallback)).enabled) {
      void window.showInformationMessage(RUN_ARGS_OFF);
      return undefined;
    }
    const document = clickedEditor(given, window.visibleTextEditors ?? [], window.activeTextEditor)?.document;
    if (document === undefined || document.uri.scheme !== "file") {
      void window.showInformationMessage("q-lint: open a q file saved on disk to run it.");
      return undefined;
    }
    const file = document.uri.toString();
    const set = givenSet(given);
    if (set !== undefined) {
      return this.runWith(document, set);
    }
    const sets = setsFor(this.context.workspaceState.get(RUN_ARGS_KEY), file);
    const items: Item[] = [
      ...sets.map((set) => ({ ...describe(set), set })),
      { label: "$(add) New arguments...", action: "new" as const },
      ...(sets.length > 0 ? [{ label: "$(trash) Forget saved arguments...", action: "forget" as const }] : []),
    ];
    const chosen = await window.showQuickPick(items, { title: "Run File with Arguments", placeHolder: "Arguments for .z.x, and input for q's console" });
    if (chosen === undefined) {
      return undefined;
    }
    if (chosen.action === "forget") {
      const gone = await window.showQuickPick(
        sets.map((set) => ({ ...describe(set), set })),
        { title: "Forget which saved arguments?" },
      );
      if (gone !== undefined) {
        await this.context.workspaceState.update(RUN_ARGS_KEY, withoutSet(this.context.workspaceState.get(RUN_ARGS_KEY), file, gone.set));
      }
      return undefined;
    }
    const picked = chosen.set ?? (await this.ask());
    if (picked === undefined) {
      return undefined;
    }
    return this.runWith(document, picked);
  }

  /// Run `document` with `set`, remembered for its file.
  private async runWith(document: TextDocument, set: ArgSet): Promise<ArgSet> {
    await this.context.workspaceState.update(RUN_ARGS_KEY, withSet(this.context.workspaceState.get(RUN_ARGS_KEY), document.uri.toString(), set));
    await this.run(extraOf(set), document);
    return set;
  }

  /// A new set: the arguments, then input a line at a time until an empty
  /// one. Escape anywhere runs nothing.
  private async ask(): Promise<ArgSet | undefined> {
    const args = await window.showInputBox({
      title: "Run File with Arguments",
      prompt: 'The words after the file, which q reads as .z.x: -p 5001 -name "a b". Double quotes keep spaces together.',
      placeHolder: "arguments (may be empty)",
    });
    if (args === undefined) {
      return undefined;
    }
    const input: string[] = [];
    for (;;) {
      const line = await window.showInputBox({
        title: `Run File with Arguments: input line ${input.length + 1}`,
        prompt: "A line typed into q's console once it starts. Empty: no more input, run.",
        placeHolder: "q code, or empty to run",
      });
      if (line === undefined) {
        return undefined;
      }
      if (line === "") {
        break;
      }
      input.push(line);
    }
    return { args, input: input.join("\n") };
  }
}
