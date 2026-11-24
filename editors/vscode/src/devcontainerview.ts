// **Add q Dev Container Configuration** (#977): shows the template's files
// (`devcontainer.ts`) in a preview, and writes them into the workspace
// folder only when the dialog's **Write** is chosen. A file already there
// is left as it is and named in the preview; one that appears between the
// preview and the write is left too.
import * as path from "node:path";
import { FileType, Uri, commands, window, workspace, type ExtensionContext, type WorkspaceFolder } from "vscode";
import { DEVCONTAINER_COMMAND, otherConfigs, plan, previewText, readDevContainer, templateFiles } from "./devcontainer";
import { plainMessage } from "./history";
import { assertWritable } from "./workspacewrite";

const exists = async (uri: Uri): Promise<boolean> => {
  try {
    await workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
};

/// Run the command; the paths written, for tests and the e2e run.
export async function addDevContainer(): Promise<string[]> {
  if (!readDevContainer((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).enabled) {
    void window.showInformationMessage("q-lint: The q dev container template is turned off. Set q-lint.devContainer.enable to true to turn it on.");
    return [];
  }
  const folders = workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void window.showErrorMessage("q-lint: open a folder first: the dev container configuration is written into a workspace folder.");
    return [];
  }
  let folder: WorkspaceFolder | undefined = folders[0];
  if (folders.length > 1) {
    folder = await window.showWorkspaceFolderPick({ placeHolder: "Add the q dev container to which folder?" });
  }
  if (folder === undefined) {
    return [];
  }
  const root = folder.uri;
  const subfolders = await workspace.fs.readDirectory(Uri.joinPath(root, ".devcontainer")).then(
    (entries) => entries.filter(([, type]) => type === FileType.Directory).map(([name]) => name),
    () => [],
  );
  for (const other of otherConfigs(subfolders)) {
    if (await exists(Uri.joinPath(root, ...other.split("/")))) {
      void window.showInformationMessage(plainMessage(`q-lint: ${folder.name} has a dev container configuration already, ${other}; nothing was written.`));
      return [];
    }
  }
  const files = templateFiles();
  const there = new Set<string>();
  for (const file of files) {
    if (await exists(Uri.joinPath(root, ...file.path.split("/")))) {
      there.add(file.path);
    }
  }
  const planned = plan(files, (p) => there.has(p));
  if (planned.write.length === 0) {
    void window.showInformationMessage(plainMessage(`q-lint: ${folder.name} already has ${planned.skip.join(" and ")}; nothing was written.`));
    return [];
  }
  const document = await workspace.openTextDocument({ language: "markdown", content: previewText(folder.name, planned) });
  await window.showTextDocument(document, { preview: true });
  const skipped = planned.skip.length > 0 ? ` ${planned.skip.join(" and ")} ${planned.skip.length === 1 ? "is" : "are"} already there and left as ${planned.skip.length === 1 ? "it is" : "they are"}.` : "";
  // A dialog that cannot be shown is no Write.
  const answer = await Promise.resolve(
    window.showInformationMessage(
      plainMessage(`Write ${planned.write.map((f) => f.path).join(" and ")} into ${folder.name}?${skipped}`),
      { modal: true, detail: "The preview shows what would be written." },
      "Write",
    ),
  ).catch(() => undefined);
  if (answer !== "Write") {
    return [];
  }
  const written: string[] = [];
  for (const file of planned.write) {
    const uri = Uri.joinPath(root, ...file.path.split("/"));
    // Checked again: never written over, even if it appeared since.
    if (await exists(uri)) {
      continue;
    }
    try {
      // A dangling link the repository ships is "not there" to exists (#1830).
      assertWritable(root.fsPath, uri.fsPath);
      await workspace.fs.createDirectory(Uri.joinPath(root, ...path.posix.dirname(file.path).split("/")));
      await workspace.fs.writeFile(uri, Buffer.from(file.content, "utf8"));
    } catch (error) {
      const done = written.length > 0 ? ` ${written.join(" and ")} ${written.length === 1 ? "was" : "were"} written.` : "";
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}.${done}`));
      return written;
    }
    written.push(file.path);
  }
  void window.showInformationMessage(
    plainMessage(`q-lint: wrote ${written.join(" and ") || "nothing"} into ${folder.name}. Reopen in Container (Dev Containers) or create a codespace to use it.`),
  );
  return written;
}

export function registerDevContainer(context: ExtensionContext): void {
  context.subscriptions.push(commands.registerCommand(DEVCONTAINER_COMMAND, () => addDevContainer()));
}
