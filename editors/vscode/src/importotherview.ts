// Import from qStudio and from KX's extension (#1033): where to read from,
// what it gives, and adding it after asking. What is read is
// `importother.ts`'s. A label already in the list is not replaced, and no
// password is ever taken. Nothing is sent to any process.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Uri, commands, env, window, workspace, type ExtensionContext } from "vscode";
import { ADMIN_COMMANDS, adminOff, readAdmin } from "./admin";
import { readKxExport, readKxServers, readQStudio, type Imported } from "./importother";
import type { Live } from "./live";
import { plainMessage } from "./history";

const on = (): boolean => readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).importOther;

/// Where qStudio's preferences are on this machine, when they are there.
export function qStudioPrefsFiles(home = os.homedir(), platform = process.platform): string[] {
  const candidates =
    platform === "darwin"
      ? [path.join(home, "Library", "Preferences", "com.timestored.qstudio.plist"), path.join(home, "Library", "Preferences", "com.apple.java.util.prefs.plist")]
      : platform === "win32"
        ? []
        : [path.join(home, ".java", ".userPrefs", "com", "timestored", "qstudio", "prefs.xml")];
  return candidates.filter((f) => fs.existsSync(f));
}

/// A file's text; a binary plist as `plutil` writes it in XML (macOS).
async function readText(file: Uri): Promise<string> {
  const data = Buffer.from(await workspace.fs.readFile(file));
  if (data.subarray(0, 6).toString("latin1") !== "bplist") {
    return data.toString("utf8").replace(/^﻿/, "");
  }
  return new Promise((resolve, reject) =>
    execFile("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", file.fsPath], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(new Error(`could not read the plist: ${error.message}`)) : resolve(stdout),
    ),
  );
}

export class ImportOther {
  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "processes" | "saveProcesses">,
  ) {
    context.subscriptions.push(
      commands.registerCommand(ADMIN_COMMANDS.importQStudio, (file?: Uri) => this.qStudio(file)),
      commands.registerCommand(ADMIN_COMMANDS.importKx, (file?: Uri) => this.kx(file)),
    );
  }

  /// Import qStudio's servers from `file`, or from where the user picks.
  async qStudio(file?: Uri): Promise<number> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("importOther")));
      return 0;
    }
    let text: string;
    let from: string;
    try {
      if (file instanceof Uri) {
        text = await readText(file);
        from = file.fsPath;
      } else {
        const found = qStudioPrefsFiles();
        const picked = await window.showQuickPick(
          [
            { label: "From the clipboard", detail: "What qStudio's Server > Copy Server List put there", id: "clipboard" },
            ...found.map((f) => ({ label: "qStudio's saved servers", detail: f, id: f })),
            { label: "From a file...", detail: "A Copy Server List text, a <serverlist> XML, or qStudio's preferences file", id: "file" },
          ],
          { title: "Import servers from qStudio (passwords are not imported)" },
        );
        if (picked === undefined) {
          return 0;
        }
        if (picked.id === "clipboard") {
          text = await env.clipboard.readText();
          from = "the clipboard";
        } else {
          const chosen =
            picked.id === "file" ? (await window.showOpenDialog({ title: "qStudio server list", canSelectMany: false }))?.[0] : Uri.file(picked.id);
          if (chosen === undefined) {
            return 0;
          }
          text = await readText(chosen);
          from = chosen.fsPath;
        }
      }
      return await this.add(readQStudio(text), "qStudio", from);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not read qStudio's servers: ${error instanceof Error ? error.message : String(error)}`));
      return 0;
    }
  }

  /// Import KX's kdb connections from an export `file`, or from this VS
  /// Code's settings or a file the user picks.
  async kx(file?: Uri): Promise<number> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("importOther")));
      return 0;
    }
    try {
      let chosen = file instanceof Uri ? file : undefined;
      if (chosen === undefined) {
        const picked = await window.showQuickPick(
          [
            { label: "From this VS Code's settings", detail: "kdb.servers, with kdb.labelsConnectionMap's labels as tags", id: "settings" },
            { label: "From an export file...", detail: "What KX's Export Connections wrote", id: "file" },
          ],
          { title: "Import connections from the KX kdb extension (passwords are not imported)" },
        );
        if (picked === undefined) {
          return 0;
        }
        if (picked.id === "settings") {
          const kdb = workspace.getConfiguration("kdb");
          return await this.add(readKxServers(kdb.get<unknown>("servers"), kdb.get<unknown>("labelsConnectionMap")), "KX's extension", "kdb.servers");
        }
        chosen = (await window.showOpenDialog({ title: "KX connections export", canSelectMany: false, filters: { JSON: ["json"] } }))?.[0];
        if (chosen === undefined) {
          return 0;
        }
      }
      return await this.add(readKxExport(JSON.parse(await readText(chosen))), "KX's extension", chosen.fsPath);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not read KX's connections: ${error instanceof Error ? error.message : String(error)}`));
      return 0;
    }
  }

  /// Add what was read, after saying what it is and asking; a label
  /// already saved is kept as it is. How many were added.
  private async add(read: Imported, tool: string, from: string): Promise<number> {
    const now = this.live.processes();
    const taken = new Set(now.map((p) => p.label));
    const adding = read.processes.filter((p) => !taken.has(p.label));
    const kept = read.processes.length - adding.length;
    const notes = [...read.skipped, ...(kept > 0 ? [`${kept} already in the list, kept as they are`] : [])];
    if (adding.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: ${from} names no new q process to import.${notes.length ? ` ${notes.slice(0, 5).join("; ")}.` : ""}`));
      return 0;
    }
    const yes = "Import";
    const names = adding.map((p) => p.label);
    const answer = await window.showInformationMessage(
      plainMessage(`Import ${adding.length} q process(es) from ${tool} (${from})? ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", ..." : ""}`),
      { modal: true, detail: `No password is imported: each is asked for on connect.${notes.length ? `\n\nNot imported: ${notes.slice(0, 10).join("; ")}.` : ""}` },
      yes,
    );
    if (answer !== yes) {
      return 0;
    }
    // Read again: the list may have changed while the question was open.
    const latest = this.live.processes();
    const fresh = adding.filter((p) => !latest.some((q) => q.label === p.label));
    await this.live.saveProcesses([...latest, ...fresh]);
    void window.showInformationMessage(plainMessage(`q-lint: imported ${fresh.length} q process(es) from ${tool}.`));
    return fresh.length;
  }
}
