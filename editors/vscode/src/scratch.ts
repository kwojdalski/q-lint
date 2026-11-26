// Scratch buffers per process (#1051): **Open Scratch Buffer**, on a
// process's context menu or in the palette, opens that process's own q file,
// kept in the extension's global storage - so it is there in the next
// session, in any workspace, and never in the user's repository - and binds
// it to the process, as Choose Connection for File does, so what is run
// from it goes there. It sends nothing: a query run from it is an ordinary
// query, with the read-only guard and the production confirmation. Off
// (q-lint.processes.scratchBuffer.enable), the command refuses and opens
// nothing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Uri, commands, window, workspace, type ExtensionContext } from "vscode";
import type { Live, ProcessArg } from "./live";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";
import { CONTROL_COMMANDS } from "./querycontrols";
import { plainMessage } from "./history";
import { SHARED_SOURCE } from "./discovery";
import { sharedScope } from "./processes";

/// The file a process's scratch buffer is kept in: its label made safe for
/// a file name, and a short hash of the label so two labels that clean up
/// alike stay apart. A shared-list process's is hashed with its `scope`
/// too, the folder and address: another repository's `.qlint/rdb` is
/// another process, and is not given this one's buffer (#1824).
export function scratchFileName(label: string, scope?: string): string {
  const safe = label.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "process";
  const hash = createHash("sha256")
    .update(scope === undefined ? label : `${label}\n${scope}`)
    .digest("hex")
    .slice(0, 8);
  return `${safe}-${hash}.q`;
}

/// What a new scratch buffer starts with.
export function scratchHeader(label: string): string {
  return `/ Scratch buffer for ${label.replace(/[\r\n]+/g, " ")}: kept by q-lint between sessions. Queries run from it go to ${label.replace(/[\r\n]+/g, " ")}.\n\n`;
}

/// The saved process `from` was renamed `to`, or deleted (`to` undefined):
/// its buffer, kept by label, moves with it, or is put aside under
/// `scratch/deleted`, so the next process given the label starts empty
/// (#2405). One already kept under `to`, left by an earlier process of that
/// label, is put aside first. `storage`: the extension's global storage.
export function moveScratch(storage: string | undefined, from: string, to: string | undefined): void {
  if (typeof storage !== "string") {
    return;
  }
  try {
    const dir = join(storage, "scratch");
    const old = join(dir, scratchFileName(from));
    const aside = (path: string, label: string): void => {
      if (existsSync(path)) {
        mkdirSync(join(dir, "deleted"), { recursive: true });
        renameSync(path, join(dir, "deleted", `${Date.now()}-${scratchFileName(label)}`));
      }
    };
    if (!existsSync(old)) {
      return;
    }
    if (to === undefined) {
      aside(old, from);
      return;
    }
    const path = join(dir, scratchFileName(to));
    aside(path, to);
    const text = readFileSync(old, "utf8");
    // Its header names the process it is for.
    if (text.startsWith(scratchHeader(from))) {
      writeFileSync(old, scratchHeader(to) + text.slice(scratchHeader(from).length));
    }
    renameSync(old, path);
  } catch {
    // A buffer that cannot be moved is left where it is: the rename stands.
  }
}

export function registerScratchBuffers(
  context: ExtensionContext,
  live: Pick<Live, "pick" | "sharedFolder">,
): { open: (row?: ProcessArg) => Promise<{ path: string; label: string } | string> } {
  const open = async (row?: ProcessArg): Promise<{ path: string; label: string } | string> => {
    if (!toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "scratchBuffer")) {
      const off = toolOff("scratchBuffer");
      void window.showInformationMessage(plainMessage(off));
      return off;
    }
    const process = await live.pick(row, "Open the scratch buffer of which q process?");
    if (process === undefined) {
      return "no process";
    }
    const dir = join(context.globalStorageUri.fsPath, "scratch");
    // By the folder whose list names it, as its password is (#2513).
    const scope = process.server === SHARED_SOURCE ? sharedScope(process, live.sharedFolder(process.label)) : undefined;
    const path = join(dir, scratchFileName(process.label, scope));
    try {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(path)) {
        // `wx`: never over a file another window made meanwhile.
        writeFileSync(path, scratchHeader(process.label), { flag: "wx" });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        const message = `q-lint: could not create the scratch buffer of ${process.label}: ${error instanceof Error ? error.message : String(error)}`;
        void window.showErrorMessage(plainMessage(message));
        return message;
      }
    }
    const document = await workspace.openTextDocument(Uri.file(path));
    await window.showTextDocument(document);
    await commands.executeCommand(CONTROL_COMMANDS.chooseFileConnection, process.label, document.uri);
    return { path, label: process.label };
  };
  context.subscriptions.push(commands.registerCommand(PROCESS_TOOL_COMMANDS.openScratch, (row?: ProcessArg) => open(row)));
  return { open };
}
