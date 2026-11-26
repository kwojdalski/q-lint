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
import { assertWritable, linkProblem } from "./workspacewrite";

export const BASELINE_FILE = "qlinter-baseline.json";

/// `f` of `text` read with LF line ends, and its answer written back with
/// CRLF ones when every line of `text` ends so: the lines added are the
/// file's own, not LF among CRLF (#2523).
function inLineEnds<T extends string | undefined | null>(text: string, f: (lf: string) => T): T {
  const crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
  const out = f(crlf ? text.replace(/\r\n/g, "\n") : text);
  return (crlf && typeof out === "string" ? out.replace(/\n/g, "\r\n") : out) as T;
}

/// `text`, a `qlinter.toml`, with `baseline = "<file>"` as its first key -
/// a top-level key has to come before any `[table]` - or undefined when it
/// names a baseline already.
export function tomlWithBaseline(text: string, file = BASELINE_FILE): string | undefined {
  return inLineEnds(text, (lf) => tomlWithBaselineLf(lf, file));
}

function tomlWithBaselineLf(text: string, file: string): string | undefined {
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

/// `text`, a `pyproject.toml`, with `baseline = "<file>"` in the table
/// qlinter reads, as config.rs finds it: `[tool.qlinter]`, or the older
/// `[tool.q-lint]` (#2179). Its keys may also be only sub-tables
/// (`[tool.qlinter.lint]`), which get the table itself, or dotted keys under
/// `[tool]`. Undefined when that table names a baseline already; null when
/// the table is written some other way (an inline table) and the line has
/// to be added by hand.
export function pyprojectWithBaseline(text: string, file = BASELINE_FILE): string | undefined | null {
  return inLineEnds(text, (lf) => pyprojectWithBaselineLf(lf, file));
}

function pyprojectWithBaselineLf(text: string, file: string): string | undefined | null {
  const lines = text.split("\n");
  const line = `baseline = "${file}"`;
  const header = (l: string): RegExpExecArray | null =>
    /^\s*\[\s*tool\s*\.\s*("?)(qlinter|q-lint)\1\s*(\.[^\]]*)?\]\s*(#.*)?$/.exec(l);
  const tableEnd = (at: number): number => {
    const end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l));
    return end < 0 ? lines.length : end;
  };
  const own = lines.findIndex((l) => header(l) !== null && header(l)![3] === undefined);
  if (own >= 0) {
    if (lines.slice(own + 1, tableEnd(own)).some((l) => /^\s*baseline\s*=/.test(l))) {
      return undefined;
    }
    lines.splice(own + 1, 0, line);
    return lines.join("\n");
  }
  // Dotted keys in [tool]: `qlinter.select = [...]`.
  const tool = lines.findIndex((l) => /^\s*\[\s*tool\s*\]\s*(#.*)?$/.test(l));
  const dotted = tool < 0 ? [] : lines.slice(tool + 1, tableEnd(tool)).map((l) => /^\s*("?)(qlinter|q-lint)\1\s*(\.|=)\s*"?(\w*)/.exec(l));
  if (dotted.some((m) => m !== null && m[3] === "=")) {
    return null;
  }
  const key = dotted.find((m) => m !== null);
  if (key) {
    if (dotted.some((m) => m !== null && m[4] === "baseline")) {
      return undefined;
    }
    lines.splice(tool + 1, 0, `${key[2]}.${line}`);
    return lines.join("\n");
  }
  // Only sub-tables: the table goes before the first of them.
  const sub = lines.findIndex((l) => header(l) !== null);
  if (sub >= 0) {
    lines.splice(sub, 0, `[tool.${header(lines[sub])![2]}]`, line, "");
    return lines.join("\n");
  }
  return `${text.replace(/\n*$/, "")}${text.trim() === "" ? "" : "\n\n"}[tool.qlinter]\n${line}\n`;
}

/// The configuration file `qlinter --show-settings` says governs a folder,
/// or undefined for none (its built-in defaults).
export function governingConfiguration(stdout: string): string | undefined {
  const m = /^configuration: (.+)$/m.exec(stdout);
  return m === null || /^none\b/.test(m[1].trim()) ? undefined : m[1].trim();
}

/// Run qlinter; resolves with its output and exit code, or - for a run a
/// signal or the timeout stopped, which has no exit code - with `stopped`,
/// what is said of it: 1 would read as "findings" (#1877). Rejects when it
/// cannot be started.
export function runQlinter(
  command: string,
  args: string[],
  cwd: string,
  timeout = 300_000,
): Promise<{ code: number | null; stopped?: string; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A .cmd wrapper through a shell, as Node starts one (#1610).
    const run = launchable(command, args);
    execFile(run.command, run.args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: run.shell }, (error, stdout, stderr) => {
      const failed = error as (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
      if (failed && typeof failed.code === "string") {
        reject(new Error(`${command} could not be run: ${failed.message}`));
        return;
      }
      const out = { stdout: String(stdout), stderr: String(stderr) };
      if (failed && typeof failed.code !== "number") {
        // `killed`: by the timeout here, not by another's signal.
        const stopped = failed.killed === true ? `did not finish in ${timeout / 1000} s` : `was stopped${failed.signal ? ` (${failed.signal})` : ""} before it finished`;
        resolve({ code: null, stopped, ...out });
        return;
      }
      resolve({ code: failed ? (failed.code as number) : 0, ...out });
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
        // Stopped, what it wrote may be cut short: said, and not offered.
        if (ran.code === null) {
          const why = ran.stderr.trim() === "" ? "" : `: ${ran.stderr.trim().slice(0, 500)}`;
          void window.showWarningMessage(plainMessage(`q-lint: qlinter ${ran.stopped ?? "was stopped before it finished"}; no baseline was written${why}`));
          return undefined;
        }
        // Exit 2: an input it could not read, which a baseline would be
        // missing - and replaced with - though an older qlinter writes it (#2180).
        if (ran.code === 2) {
          void window.showWarningMessage(plainMessage(`q-lint: qlinter could not read every file; no baseline was written: ${ran.stderr.trim().slice(0, 500) || "exit 2"}`));
          return undefined;
        }
        const count = writtenCount(ran.stderr);
        if (count === undefined || !existsSync(draft)) {
          void window.showWarningMessage(plainMessage(`q-lint: qlinter wrote no baseline: ${ran.stderr.trim() || `exit ${ran.code}`}`));
          return undefined;
        }
        // A link the repository ships would take the write elsewhere (#1830).
        const linked = linkProblem(dir, target);
        if (linked !== undefined) {
          void window.showErrorMessage(plainMessage(`q-lint: ${linked}; no baseline was written.`));
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
          assertWritable(dir, target);
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
/// sides are compared in that form, a drive letter in either case (#1080),
/// and a UNC share's `//?/UNC/server/share` as `//server/share` (#2105).
export function rebased(text: string, ...folders: string[]): string {
  const canonical = (p: string): string =>
    p
      .replace(/\\/g, "/")
      .replace(/^\/\/\?\/UNC\//i, "//")
      .replace(/^\/\/\?\//, "")
      .replace(/^[a-z]:/, (d) => d.toUpperCase());
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
  // `--isolated`: the server reads no configuration, so a line added to
  // one would never reach the editor (#2296).
  if (args.includes("--isolated")) {
    void window.showInformationMessage(
      plainMessage(`q-lint: wrote ${BASELINE_FILE}. The language server runs with --isolated and reads no configuration, so the editor does not use it: \`qlinter --baseline ${target}\` does.`),
    );
    return;
  }
  // `--config FILE` or clap's `--config=FILE`: that file is the user's to
  // change, so the line is only shown (#2296).
  if (args.some((a) => a === "--config" || a.startsWith("--config="))) {
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
  if (after === null) {
    void window.showInformationMessage(plainMessage(`q-lint: wrote ${BASELINE_FILE}. Add \`baseline = "${file}"\` to the qlinter table in ${config} for the editor and qlinter to use it.`));
    return;
  }
  const add = "Add";
  const answer = await window.showInformationMessage(
    plainMessage(
      `q-lint: wrote ${BASELINE_FILE}. Add \`baseline = "${file}"\` to ${existsSync(config) ? `${config}${pyproject ? `'s [tool.${/^\s*\[\s*tool\s*\.\s*"?q-lint/m.test(before) ? "q-lint" : "qlinter"}]` : ""}` : `a new ${config}`}, so the editor and qlinter use it?`,
    ),
    add,
  );
  if (answer === add) {
    try {
      // The configuration may govern from above the folder: not a link either.
      assertWritable(dirname(config), config);
      writeFileSync(config, after);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${config}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}
