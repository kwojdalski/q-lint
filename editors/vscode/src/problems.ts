// The problems dashboard (#992), as SonarLint's: a workspace folder's
// findings counted by rule and by folder, and how the count moved over the
// commits. Free of any `vscode` import, so node tests it;
// `problemsview.ts` runs the linter and draws the page.
//
// The findings are `qlinter --format json` over the folder - the command
// line's reading, under the repository's configuration, as CI would see it,
// not the open buffers'. The trend is a point for each commit the dashboard
// has seen with the q files clean against it, kept in the workspace's state,
// and any older commits a person asks to be linted from git: each is
// exported with `git archive` to a directory of its own and linted there,
// never checked out.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

/// The part of a finding the dashboard reads.
export interface Finding {
  path: string;
  code: string;
  rule: string;
  severity: string;
  category: string;
}

/// What `qlinter --format json` printed, keeping well-formed findings.
export function readFindings(text: string): Finding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`qlinter printed something other than JSON: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error("qlinter printed something other than a list of findings");
  }
  return (raw as Record<string, unknown>[])
    .filter((f) => f !== null && typeof f === "object" && typeof f.path === "string" && typeof f.code === "string")
    .map((f) => ({
      path: f.path as string,
      code: f.code as string,
      rule: typeof f.rule === "string" ? f.rule : "",
      severity: typeof f.severity === "string" ? f.severity : "warning",
      category: typeof f.category === "string" ? f.category : "",
    }));
}

export interface RuleCount {
  code: string;
  rule: string;
  category: string;
  severity: string;
  count: number;
  files: number;
}

export interface FolderCount {
  /// Relative to the workspace folder, `/`-separated; `.` for its top.
  folder: string;
  count: number;
  errors: number;
  files: number;
}

/// One point of the trend.
export interface Point {
  commit: string;
  /// ISO date of the commit.
  date: string;
  subject: string;
  total: number;
  errors: number;
  byRule: Record<string, number>;
}

export interface Summary {
  total: number;
  errors: number;
  warnings: number;
  files: number;
  rules: RuleCount[];
  folders: FolderCount[];
}

/// The folder a file is counted under: its directory relative to `root`, cut
/// to `depth` parts, so a deep tree reads as its top folders.
export function folderOf(path: string, root: string, depth = 2): string {
  const rel = relative(root, path).split(sep).join("/");
  const parts = rel.split("/").slice(0, -1);
  if (parts.length === 0 || rel.startsWith("..")) {
    return ".";
  }
  return parts.slice(0, depth).join("/");
}

export function summarise(findings: Finding[], root: string, depth = 2): Summary {
  const rules = new Map<string, RuleCount & { paths: Set<string> }>();
  const folders = new Map<string, FolderCount & { paths: Set<string> }>();
  let errors = 0;
  for (const f of findings) {
    const error = f.severity === "error";
    errors += error ? 1 : 0;
    const r = rules.get(f.code) ?? { code: f.code, rule: f.rule, category: f.category, severity: f.severity, count: 0, files: 0, paths: new Set<string>() };
    r.count++;
    r.paths.add(f.path);
    rules.set(f.code, r);
    const name = folderOf(f.path, root, depth);
    const d = folders.get(name) ?? { folder: name, count: 0, errors: 0, files: 0, paths: new Set<string>() };
    d.count++;
    d.errors += error ? 1 : 0;
    d.paths.add(f.path);
    folders.set(name, d);
  }
  const strip = <T extends { paths: Set<string>; files: number }>(x: T): Omit<T, "paths"> => {
    const { paths, ...rest } = x;
    return { ...rest, files: paths.size };
  };
  return {
    total: findings.length,
    errors,
    warnings: findings.length - errors,
    files: new Set(findings.map((f) => f.path)).size,
    rules: [...rules.values()].map(strip).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    folders: [...folders.values()].map(strip).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder)),
  };
}

export function pointOf(findings: Finding[], commit: string, date: string, subject: string): Point {
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    byRule[f.code] = (byRule[f.code] ?? 0) + 1;
  }
  return { commit, date, subject, total: findings.length, errors: findings.filter((f) => f.severity === "error").length, byRule };
}

/// The most points kept.
export const TREND_LIMIT = 100;

/// `trend` with `point` in it - replacing one of the same commit - oldest
/// first by commit date, at most `TREND_LIMIT` of the newest. The dates
/// are compared as instants: `%cI` keeps each committer's offset, so their
/// text does not sort (#1106).
export function withPoint(trend: Point[], point: Point): Point[] {
  const kept = trend.filter((p) => p.commit !== point.commit);
  kept.push(point);
  kept.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.date.localeCompare(b.date));
  return kept.slice(-TREND_LIMIT);
}

/// The points read back from storage, keeping well-formed ones.
export function readTrend(raw: unknown): Point[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as Record<string, unknown>[]).filter(
    (p) =>
      p !== null &&
      typeof p === "object" &&
      typeof p.commit === "string" &&
      typeof p.date === "string" &&
      typeof p.total === "number" &&
      typeof p.errors === "number" &&
      p.byRule !== null &&
      typeof p.byRule === "object",
  ) as unknown as Point[];
}

/// Run a program; resolves with its stdout and exit code, or rejects when
/// it cannot be started.
export function run(command: string, args: string[], cwd: string, timeout = 300_000): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const failed = error as (Error & { code?: unknown }) | null;
      if (failed && typeof failed.code === "string") {
        reject(new Error(`${command} could not be run: ${failed.message}`));
        return;
      }
      resolve({ stdout, code: failed ? (typeof failed.code === "number" ? failed.code : 1) : 0 });
    });
  });
}

/// The findings under `dir`: `qlinter --format json .` there, with `args`
/// (a profile, a configuration file) before it. Exit 1 means findings; a
/// file that could not be read (exit 2) still lets the rest be read.
export async function lintTree(qlinter: string, args: string[], dir: string): Promise<Finding[]> {
  const { stdout, code } = await run(qlinter, [...args, "--format", "json", "."], dir);
  if (code !== 0 && code !== 1 && code !== 2) {
    throw new Error(`qlinter exited with ${code}`);
  }
  return readFindings(stdout.trim() === "" ? "[]" : stdout);
}

/// The commit `HEAD` is, its date and subject, and whether a q file differs
/// from it; undefined outside a git repository or before a first commit.
export async function head(dir: string): Promise<{ commit: string; date: string; subject: string; clean: boolean } | undefined> {
  const log = await run("git", ["log", "-1", "--format=%H%x00%cI%x00%s"], dir).catch(() => undefined);
  if (log === undefined || log.code !== 0 || log.stdout.trim() === "") {
    return undefined;
  }
  const [commit, date, subject] = log.stdout.trim().split("\0");
  const status = await run("git", ["status", "--porcelain", "--", "*.q", "*.toml"], dir).catch(() => undefined);
  return { commit, date, subject: subject ?? "", clean: status !== undefined && status.code === 0 && status.stdout.trim() === "" };
}

/// The last `count` commits before `HEAD`, newest first, as `head` gives one.
export async function history(dir: string, count: number): Promise<{ commit: string; date: string; subject: string }[]> {
  const log = await run("git", ["log", `-${count}`, "--format=%H%x00%cI%x00%s"], dir);
  if (log.code !== 0) {
    throw new Error("git log failed: is this a git repository with commits?");
  }
  return log.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [commit, date, subject] = l.split("\0");
      return { commit, date, subject: subject ?? "" };
    });
}

/// The findings of `commit`: its q files and configuration exported with
/// `git archive` into a directory of its own and linted there; the
/// directory is removed after. The working tree is never touched.
export async function lintCommit(qlinter: string, args: string[], dir: string, commit: string): Promise<Finding[]> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new Error(`not a commit: ${commit}`);
  }
  const out = await mkdtemp(join(tmpdir(), "qlint-trend-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const archive = spawn("git", ["archive", "--format=tar", commit], { cwd: dir, windowsHide: true });
      const tar = spawn("tar", ["-x", "-f", "-", "-C", out], { windowsHide: true });
      archive.stdout.pipe(tar.stdin);
      let failed = "";
      archive.stderr.on("data", (d) => (failed += d));
      archive.on("error", reject);
      tar.on("error", reject);
      tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git archive ${commit} failed: ${failed || `tar exited ${code}`}`))));
    });
    return await lintTree(qlinter, args, out);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/// What the page is sent.
export interface DashboardView {
  folder: string;
  at: string;
  /// The commit the findings are of, and whether the q files differ from it.
  commit?: string;
  clean: boolean;
  summary: Summary;
  trend: Point[];
}
