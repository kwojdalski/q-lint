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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { commands, window, workspace, type ExtensionContext } from "vscode";
import { launchable } from "./batch";
import { LANGUAGE_COMMANDS, languageOff, languageOn } from "./languagefeatures";
import { plainMessage } from "./history";

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

/// `text`, a `pyproject.toml`, with `baseline = "<file>"` first in its
/// `[tool.qlinter]` table, or undefined when that table names one already
/// or there is no such table.
export function pyprojectWithBaseline(text: string, file = BASELINE_FILE): string | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\s*\[\s*tool\.qlinter\s*\]\s*(#.*)?$/.test(l));
  if (at < 0) {
    return undefined;
  }
  const end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l));
  if (lines.slice(at + 1, end < 0 ? undefined : end).some((l) => /^\s*baseline\s*=/.test(l))) {
    return undefined;
  }
  lines.splice(at + 1, 0, `baseline = "${file}"`);
  return lines.join("\n");
}

/// The configuration file `qlinter --show-settings` says governs a folder,
/// or undefined for none (its built-in defaults).
export function governingConfiguration(stdout: string): string | undefined {
  const m = /^configuration: (.+)$/m.exec(stdout);
  return m === null || /^none\b/.test(m[1].trim()) ? undefined : m[1].trim();
}

function runQlinter(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A .cmd wrapper through a shell, as Node starts one (#1610).
    const run = launchable(command, args);
    execFile(run.command, run.args, { cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: run.shell }, (error, stdout, stderr) => {
      const failed = error as (Error & { code?: unknown }) | null;
      if (failed && typeof failed.code === "string") {
        reject(new Error(`${command} could not be run: ${failed.message}`));
        return;
      }
      resolve({ code: failed ? (typeof failed.code === "number" ? failed.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function registerBaseline(context: ExtensionContext, qlinter: () => { command: string | undefined; args: string[] }): void {
  const on = (): boolean => languageOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "baseline");
  context.subscriptions.push(
    commands.registerCommand(LANGUAGE_COMMANDS.writeBaseline, async () => {
      if (!on()) {
        void window.showInformationMessage(plainMessage(languageOff("baseline")));
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
      if (command === undefined) {
        void window.showWarningMessage("q-lint: no qlinter to run: set q-lint.serverPath, or put qlinter on PATH.");
        return undefined;
      }
      const scratch = mkdtempSync(join(tmpdir(), "qlint-baseline-"));
      try {
        const draft = join(scratch, BASELINE_FILE);
        // One that cannot be started is said, not left to VS Code's
        // "Running the contributed command failed" (#1611).
        const ran = await runQlinter(command, [...args, "--write-baseline", draft, "."], dir).catch((error: unknown) => {
          void window.showWarningMessage(plainMessage(`q-lint: ${error instanceof Error ? error.message : String(error)}`));
          return undefined;
        });
        if (ran === undefined) {
          return undefined;
        }
        const count = writtenCount(ran.stderr);
        if (count === undefined || !existsSync(draft)) {
          void window.showWarningMessage(plainMessage(`q-lint: qlinter wrote no baseline: ${ran.stderr.trim() || `exit ${ran.code}`}`));
          return undefined;
        }
        const exists = existsSync(target);
        const write = exists ? "Replace" : "Write";
        const answer = await window.showWarningMessage(
          plainMessage(`${exists ? "Replace" : "Write"} ${BASELINE_FILE} in ${folder.name}?`),
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
        // Rewritten to be relative to the folder: the draft's paths are
        // relative to the scratch directory, through `..` (#1191, #1275).
        const text = absolutePaths(readFileSync(draft, "utf8"), canonicalDir(scratch));
        try {
          writeFileSync(target, rebased(text, dir, canonicalDir(dir)));
        } catch (error) {
          void window.showErrorMessage(plainMessage(`q-lint: could not write ${target}: ${error instanceof Error ? error.message : String(error)}`));
          return undefined;
        }
        await offerConfiguration(dir, target, command, args);
        return target;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }),
  );
}

/// A baseline's `text` with each relative path - relative to `dir`, its
/// directory, `../` included - resolved against `dir`, `/`-separated. A path
/// already absolute (another Windows drive) is left as it is.
export function absolutePaths(text: string, dir: string): string {
  const base = dir.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
  return mapPaths(text, (path) => (/^(\/|[A-Za-z]:)/.test(path) ? path : posix.normalize(`${base}/${path}`)));
}

/// `text` with each finding's `"path"` - a JSON string, its escapes read
/// and written back, so that a folder named with a `"` or `\` is one path
/// (#1604) - replaced with what `f` makes of it.
function mapPaths(text: string, f: (path: string) => string): string {
  return text.replace(/"path":("(?:[^"\\]|\\.)*")/g, (whole, quoted: string) => {
    let path: unknown;
    try {
      path = JSON.parse(quoted);
    } catch {
      return whole;
    }
    return typeof path === "string" ? `"path":${JSON.stringify(f(path))}` : whole;
  });
}

/// A baseline written from a scratch directory, its paths made absolute,
/// with each path under one of `folders` (one folder's names: as opened,
/// and with its symlinks resolved) made relative to it. qlinter writes
/// canonical `/`-separated paths, `//?/C:/proj/a.q` on Windows, so both
/// sides are compared in that form, a drive letter in either case (#1080).
export function rebased(text: string, ...folders: string[]): string {
  const canonical = (p: string): string => p.replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/^[a-z]:/, (d) => d.toUpperCase());
  const prefixes = folders.map((f) => canonical(f).replace(/\/*$/, "/"));
  return mapPaths(text, (path) => {
    const prefix = prefixes.find((p) => canonical(path).startsWith(p));
    return prefix === undefined ? path : canonical(path).slice(prefix.length);
  });
}

/// `dir` with its symlinks resolved (`/tmp` is `/private/tmp` on macOS).
function canonicalDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/// Offer to name the baseline in the configuration that governs the folder
/// - as `qlinter --show-settings` finds it: a `.qlinter.toml` above it, a
/// `pyproject.toml`'s `[tool.qlinter]` - showing the line, and write it
/// only when asked. A new `qlinter.toml` only where none governs: one beside
/// another would hide it (#1602). Under q-lint.configFile (`--config`) the
/// line is only shown: that file is the user's to change.
async function offerConfiguration(dir: string, target: string, command: string, args: string[]): Promise<void> {
  const shown = await runQlinter(command, [...args, "--show-settings", "."], dir).catch(() => undefined);
  const governing = shown === undefined ? undefined : governingConfiguration(shown.stdout);
  const config = governing ?? join(dir, "qlinter.toml");
  // Named from the configuration's own directory, as qlinter reads it.
  const file = relative(canonicalDir(dirname(config)), join(canonicalDir(dirname(target)), basename(target))).split(sep).join("/");
  if (args.includes("--config")) {
    void window.showInformationMessage(
      plainMessage(`q-lint: wrote ${BASELINE_FILE}. q-lint.configFile names the configuration: add \`baseline = "${file}"\` to ${config} for the editor and qlinter to use it.`),
    );
    return;
  }
  const before = existsSync(config) ? readFileSync(config, "utf8") : "";
  const pyproject = basename(config) === "pyproject.toml";
  const after = pyproject ? pyprojectWithBaseline(before, file) : tomlWithBaseline(before, file);
  if (after === undefined) {
    void window.showInformationMessage(plainMessage(`q-lint: wrote ${BASELINE_FILE}; ${config} already names a baseline.`));
    return;
  }
  const add = "Add";
  const answer = await window.showInformationMessage(
    plainMessage(
      `q-lint: wrote ${BASELINE_FILE}. Add \`baseline = "${file}"\` to ${existsSync(config) ? `${config}${pyproject ? "'s [tool.qlinter]" : ""}` : `a new ${config}`}, so the editor and qlinter use it?`,
    ),
    add,
  );
  if (answer === add) {
    try {
      writeFileSync(config, after);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${config}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}
