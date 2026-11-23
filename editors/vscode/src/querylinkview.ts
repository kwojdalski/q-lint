// Shareable query links (#1038): Copy Query Link puts a `vscode://` link
// to the editor's query, aimed at a process by its label, on the
// clipboard; opening one shows the query in a new q editor bound to that
// process and asks before running it. Run, it goes as a query from that
// editor goes (`Live.queryFilledIn`): its placeholders asked for, and the
// read-only guard reading it first. The
// link handler is registered only while the feature is on.
import { commands, env, window, workspace, type Disposable, type ExtensionContext, type Uri } from "vscode";
import { ADMIN_COMMANDS, adminOff, readAdmin } from "./admin";
import type { Live } from "./live";
import { CONTROL_COMMANDS } from "./querycontrols";
import { queryLink, readQueryLink } from "./querylink";

const on = (): boolean => readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).queryLinks;

export class QueryLinks {
  private handler: Disposable | undefined;
  private readonly extensionId: string;

  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "codeFromEditor" | "activeLabel" | "fileBinding" | "named" | "pick" | "queryFilledIn">,
  ) {
    this.extensionId = context.extension?.id ?? "wojdalski.q-lint";
    context.subscriptions.push(
      commands.registerCommand(ADMIN_COMMANDS.copyLink, () => this.copy()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.query.links")) {
          this.sync();
        }
      }),
      { dispose: () => this.handler?.dispose() },
    );
    this.sync();
  }

  /// The link handler, while the feature is on.
  private sync(): void {
    if (on() && this.handler === undefined) {
      this.handler = window.registerUriHandler({ handleUri: (uri: Uri) => void this.open(uri) });
    } else if (!on() && this.handler !== undefined) {
      this.handler.dispose();
      this.handler = undefined;
    }
  }

  /// Copy the link to the editor's query, aimed at the file's process, the
  /// connected one, or one picked. The link, for tests.
  async copy(): Promise<string | undefined> {
    if (!on()) {
      void window.showInformationMessage(adminOff("queryLinks"));
      return undefined;
    }
    // Placeholders stay as written: whoever opens it is asked for them.
    const code = await this.live.codeFromEditor(false);
    if (code === undefined) {
      return undefined;
    }
    const uri = window.activeTextEditor?.document.uri;
    const label = (uri === undefined ? undefined : this.live.fileBinding(uri)) ?? this.live.activeLabel() ?? (await this.live.pick(undefined, "Link the query to which q process?"))?.label;
    if (label === undefined) {
      return undefined;
    }
    const made = queryLink(env.uriScheme ?? "vscode", this.extensionId, label, code);
    if ("problem" in made) {
      void window.showInformationMessage(`q-lint: no link: ${made.problem}.`);
      return undefined;
    }
    await env.clipboard.writeText(made.link);
    void window.showInformationMessage(`q-lint: copied a link to the query on ${label}. Opening it shows the query and asks before running it.`);
    return made.link;
  }

  /// Open a link: the query in a new q editor, bound to its process when
  /// that is one here, and run only if the user says so. Whether it ran.
  async open(uri: Pick<Uri, "path" | "query">): Promise<boolean> {
    if (!on()) {
      void window.showInformationMessage(adminOff("queryLinks"));
      return false;
    }
    const read = readQueryLink(uri.path, uri.query);
    if ("problem" in read) {
      void window.showErrorMessage(`q-lint: cannot open the link: ${read.problem}.`);
      return false;
    }
    const document = await workspace.openTextDocument({ language: "q", content: read.code });
    await window.showTextDocument(document);
    if (read.process === undefined) {
      void window.showInformationMessage("q-lint: the link names no process; its query is open, to run where you choose.");
      return false;
    }
    // Saved, discovered or shared, as Copy offered it (#1125).
    const known = this.live.named(read.process) !== undefined;
    if (!known) {
      void window.showWarningMessage(`q-lint: the link is for a process labelled "${read.process}", which is not in your Processes list; its query is open, not bound or run.`);
      return false;
    }
    await commands.executeCommand(CONTROL_COMMANDS.chooseFileConnection, read.process);
    const yes = "Run";
    const answer = await window.showWarningMessage(
      `A link asks to run this query on ${read.process}. Run it?`,
      { modal: true, detail: read.code.length > 2000 ? `${read.code.slice(0, 2000)}\n...` : read.code },
      yes,
    );
    if (answer !== yes) {
      return false;
    }
    // Its placeholders are asked for, as Query Current Block asks (#1225).
    await this.live.queryFilledIn(read.code, document.uri);
    return true;
  }
}
