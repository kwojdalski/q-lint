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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Uri, commands, window, workspace, type ExtensionContext } from "vscode";
import type { Live, ProcessArg } from "./live";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";
import { CONTROL_COMMANDS } from "./querycontrols";
import { plainMessage } from "./history";

/// The file a process's scratch buffer is kept in: its label made safe for
/// a file name, and a short hash of the label so two labels that clean up
/// alike stay apart.
export function scratchFileName(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "process";
  const hash = createHash("sha256").update(label).digest("hex").slice(0, 8);
  return `${safe}-${hash}.q`;
}

/// What a new scratch buffer starts with.
export function scratchHeader(label: string): string {
  return `/ Scratch buffer for ${label.replace(/[\r\n]+/g, " ")}: kept by q-lint between sessions. Queries run from it go to ${label.replace(/[\r\n]+/g, " ")}.\n\n`;
}

export function registerScratchBuffers(
  context: ExtensionContext,
  live: Pick<Live, "pick">,
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
    const path = join(dir, scratchFileName(process.label));
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
    await window.showTextDocument(await workspace.openTextDocument(Uri.file(path)));
    // The file connection binds the active editor, which this one now is.
    await commands.executeCommand(CONTROL_COMMANDS.chooseFileConnection, process.label);
    return { path, label: process.label };
  };
  context.subscriptions.push(commands.registerCommand(PROCESS_TOOL_COMMANDS.openScratch, (row?: ProcessArg) => open(row)));
  return { open };
}
