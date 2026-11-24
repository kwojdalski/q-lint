// Formatting only the changed lines on save (#989), as Black's and Ruff's
// format-modified do: which lines of a q file changed against git `HEAD`,
// worked out here, and the language server's `q-lint/formatChangedLines`
// making the safe fixes for the findings on those lines only. The server
// starts no process, so git is asked here. Free of any `vscode` import, so
// node tests it; `formatchangedview.ts` hooks it to the save.
//
// Outside a git repository nothing is changed. A file git does not track
// yet, or a repository with no commit, has every line new: the whole file is
// formatted, as Format Document would.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import { onProcessPath } from "./relations";

/// Lines of `after` that are not in `before`, as pairs of 0-based first and
/// last lines, inclusive. Where lines were only deleted, the line that took
/// their place is counted: joining two lines can make a finding on it.
///
/// The lines both share at either end are trimmed first; what is left is
/// matched by its longest common subsequence while that is small enough to
/// compute (`budget` cells), and taken as changed whole when it is not.
export function changedLines(before: string, after: string, budget = 4_000_000): [number, number][] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const oldMiddle = a.slice(head, a.length - tail);
  const newMiddle = b.slice(head, b.length - tail);
  if (oldMiddle.length === 0 && newMiddle.length === 0) {
    return [];
  }
  const changed = new Set<number>();
  const deletedAt = (i: number): void => void changed.add(Math.min(Math.max(i, 0), b.length - 1));
  if (newMiddle.length === 0) {
    deletedAt(head);
  } else if (oldMiddle.length === 0 || oldMiddle.length * newMiddle.length > budget) {
    newMiddle.forEach((_, i) => changed.add(head + i));
  } else {
    // lcs[i][j]: the longest common subsequence of oldMiddle[i..] and newMiddle[j..].
    const n = oldMiddle.length;
    const m = newMiddle.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = oldMiddle[i] === newMiddle[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && oldMiddle[i] === newMiddle[j]) {
        i++;
        j++;
      } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
        changed.add(head + j);
        j++;
      } else {
        // A line replaced is the line added in its place, already counted.
        if (j === 0 || !changed.has(head + j - 1)) {
          deletedAt(head + j);
        }
        i++;
      }
    }
  }
  const lines = [...changed].sort((x, y) => x - y);
  const ranges: [number, number][] = [];
  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && line <= last[1] + 1) {
      last[1] = Math.max(last[1], line);
    } else {
      ranges.push([line, line]);
    }
  }
  return ranges;
}

/// Run git in `cwd`; resolves with stdout, or undefined when it fails.
export type Git = (args: string[], cwd: string) => Promise<string | undefined>;

export const runGit: Git = (args, cwd) =>
  new Promise((resolve) => {
    // Found on PATH, not in the q file's folder as Windows would (#1407, #1538).
    const git = onProcessPath("git");
    if (git === undefined) {
      resolve(undefined);
      return;
    }
    execFile(git, args, { cwd, timeout: 5000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    );
  });

/// What the file at `path` was at `HEAD`: its text, `""` for a file git does
/// not track there (every line is new), or undefined outside a git
/// repository, or when git cannot say (a timeout, a lock), where nothing is
/// to be formatted.
export async function committedText(path: string, git: Git = runGit): Promise<string | undefined> {
  const cwd = dirname(path);
  const top = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
  if (top === undefined || top === "") {
    return undefined;
  }
  // git names the top through symlinks resolved: /tmp is /private/tmp.
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // A file not saved yet: as it is named.
  }
  const name = relative(top, real).split("\\").join("/");
  // `HEAD:./name` would be relative to cwd; the top-level path is not.
  const text = await git(["show", `HEAD:${name}`], top);
  if (text !== undefined) {
    return text;
  }
  // `show` fails for a path HEAD lacks, and also on a timeout or a lock:
  // only a path git says HEAD lacks is new (#1369).
  const listed = await git(["ls-tree", "--name-only", "HEAD", "--", name], top);
  if (listed !== undefined) {
    return listed.trim() === "" ? "" : undefined;
  }
  // No HEAD to list: a repository without a commit yet, whose branch is
  // named but does not exist, holds every line as new.
  const branch = (await git(["symbolic-ref", "-q", "HEAD"], top))?.trim();
  const exists = branch === undefined || branch === "" ? undefined : await git(["for-each-ref", branch], top);
  return exists !== undefined && exists.trim() === "" ? "" : undefined;
}
