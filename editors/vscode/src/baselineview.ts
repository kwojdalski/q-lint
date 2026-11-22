// The lint baseline (#1056) in the editor. The language server honours the
// `baseline` a folder's configuration names (`qlinter --baseline`'s file):
// the findings in it are not shown, and a new one is. **q-lint: Write Lint
// Baseline** writes one: it runs `qlinter --write-baseline` over the folder
// into a scratch file, says how many findings it holds, and only when asked
// writes `qlinter-baseline.json` into the folder - asking again before it
// replaces one - and then offers to name it in the folder's `qlinter.toml`,
// showing the line. Off (q-lint.baseline.enable), the command refuses and
// the server shows every finding. Nothing is sent to a q process.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands, window, workspace, type ExtensionContext } from "vscode";
import { LANGUAGE_COMMANDS, languageOff, languageOn } from "./languagefeatures";

export const BASELINE_FILE = "qlinter-baseline.json";

/// `text`, a `qlinter.toml`, with `baseline = "<file>"` as its first key -
/// a top-level key has to come before any `[table]` - or undefined when it
/// names a baseline already.
export function tomlWithBaseline(text: string, file = BASELINE_FILE): string | undefined {
  if (/^\s*baseline\s*=/m.test(text)) {
    return undefined;
  }
  const lines = text.split("\n");
  // After the comments and blank lines it opens with.
  let at = 0;
  while (at < lines.length && /^\s*(#.*)?$/.test(lines[at]) && lines[at].trim() !== "") {
    at++;
  }
  lines.splice(at, 0, `baseline = "${file}"`);
  return lines.join("\n");
}

/// The count `qlinter --write-baseline` reports on standard error.
export function writtenCount(stderr: string): { findings: number; files: number } | undefined {
  const m = /wrote (\d+) finding\(s\) in (\d+) file\(s\)/.exec(stderr);
  return m ? { findings: Number(m[1]), files: Number(m[2]) } : undefined;
}

function runQlinter(command: string, args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      const failed = error as (Error & { code?: unknown }) | null;
      if (failed && typeof failed.code === "string") {
        reject(new Error(`${command} could not be run: ${failed.message}`));
        return;
      }
      resolve({ code: failed ? (typeof failed.code === "number" ? failed.code : 1) : 0, stderr: String(stderr) });
    });
  });
}

export function registerBaseline(context: ExtensionContext, qlinter: () => { command: string; args: string[] }): void {
  const on = (): boolean => languageOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "baseline");
  context.subscriptions.push(
    commands.registerCommand(LANGUAGE_COMMANDS.writeBaseline, async () => {
      if (!on()) {
        void window.showInformationMessage(languageOff("baseline"));
        return undefined;
      }
      const folders = (workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
      const folder =
        folders.length <= 1
          ? folders[0]
          : await window.showWorkspaceFolderPick({ placeHolder: "The folder to write a lint baseline for" });
      if (folder === undefined) {
        if (folders.length === 0) {
          void window.showInformationMessage("q-lint: open a folder to write a lint baseline for it.");
        }
        return undefined;
      }
      const dir = folder.uri.fsPath;
      const target = join(dir, BASELINE_FILE);
      const { command, args } = qlinter();
      const scratch = mkdtempSync(join(tmpdir(), "qlint-baseline-"));
      try {
        const draft = join(scratch, BASELINE_FILE);
        const ran = await runQlinter(command, [...args, "--write-baseline", draft, "."], dir);
        const count = writtenCount(ran.stderr);
        if (count === undefined || !existsSync(draft)) {
          void window.showWarningMessage(`q-lint: qlinter wrote no baseline: ${ran.stderr.trim() || `exit ${ran.code}`}`);
          return undefined;
        }
        const exists = existsSync(target);
        const write = exists ? "Replace" : "Write";
        const answer = await window.showWarningMessage(
          `${exists ? "Replace" : "Write"} ${BASELINE_FILE} in ${folder.name}?`,
          {
            modal: true,
            detail:
              `It will hold today's ${count.findings} finding(s) in ${count.files} file(s); the editor and qlinter then report only findings that are not in it.` +
              (exists ? ` The ${BASELINE_FILE} there now is replaced.` : ""),
          },
          write,
        );
        if (answer !== write) {
          return undefined;
        }
        // Rewritten to be relative to the folder, as the draft's paths were
        // relative to the scratch directory.
        const text = readFileSync(draft, "utf8");
        writeFileSync(target, rebased(text, dir));
        await offerConfiguration(dir);
        return target;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }),
  );
}

/// A baseline written from a scratch directory, whose paths are absolute,
/// with each path under `to` made relative to it.
export function rebased(text: string, to: string): string {
  const prefix = to.endsWith("/") ? to : `${to}/`;
  return text.replace(/"path":"([^"]*)"/g, (whole, path: string) =>
    path.startsWith(prefix) ? `"path":"${path.slice(prefix.length)}"` : whole,
  );
}

/// Offer to name the baseline in the folder's `qlinter.toml`, showing the
/// line, and write it only when asked.
async function offerConfiguration(dir: string): Promise<void> {
  const candidates = [".qlinter.toml", "qlinter.toml"].map((n) => join(dir, n));
  const config = candidates.find((p) => existsSync(p)) ?? join(dir, "qlinter.toml");
  const before = existsSync(config) ? readFileSync(config, "utf8") : "";
  const after = tomlWithBaseline(before);
  if (after === undefined) {
    void window.showInformationMessage(`q-lint: wrote ${BASELINE_FILE}; ${config} already names a baseline.`);
    return;
  }
  const add = "Add";
  const answer = await window.showInformationMessage(
    `q-lint: wrote ${BASELINE_FILE}. Add \`baseline = "${BASELINE_FILE}"\` to ${existsSync(config) ? config : `a new ${config}`}, so the editor and qlinter use it?`,
    add,
  );
  if (answer === add) {
    writeFileSync(config, after);
  }
}
