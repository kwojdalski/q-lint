// Writes into a workspace folder, which may be a repository from anywhere
// (#1830). A file or folder the repository ships as a symbolic link would
// take a write elsewhere: `qlinter-baseline.json` linked to `~/.zshrc` was
// replaced by Write Lint Baseline, and a dangling link made the "never over
// a file" checks see nothing there and create the file it points at. No
// `vscode` import, so node tests it.
import * as fs from "node:fs";
import * as path from "node:path";

/// `file` relative to `root` when it is inside it, under it and not `root`
/// itself; undefined otherwise. The way out is a first segment of `..`: one
/// that only starts with two dots (`..lib`, `...`) is a folder's name, and
/// what is under it is inside (#2002).
export function relativeInside(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  return rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? undefined : rel;
}

/// Why `file` is not written as a file of `root`, or undefined when it may
/// be: `file` outside `root`, or a symbolic link at it or at a folder on the
/// way to it from `root` (`root` itself may be one). What does not exist yet
/// is made by the write, so the walk stops there.
export function linkProblem(root: string, file: string): string | undefined {
  const rel = relativeInside(root, file);
  if (rel === undefined) {
    return `${file} is not inside ${root}`;
  }
  let at = root;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(at);
    } catch {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      return `${path.relative(root, at)} is a symbolic link, which q-lint does not write through`;
    }
  }
  return undefined;
}

/// The folder of `folders` that holds `file`, the innermost, if any.
export function folderOf(folders: readonly string[], file: string): string | undefined {
  const inside = folders.filter((f) => relativeInside(f, file) !== undefined);
  return inside.sort((a, b) => b.length - a.length)[0];
}

/// Throw when `file`, in one of `folders`, is not to be written as a file of
/// it; a file in none is the user's own choice, and is written.
export function assertWritableIn(folders: readonly { uri: { fsPath: string } }[] | undefined, file: string): void {
  const folder = folderOf((folders ?? []).map((f) => f.uri.fsPath), file);
  if (folder !== undefined) {
    assertWritable(folder, file);
  }
}

/// Throw when `file` is not to be written as a file of `root`: the caller's
/// own "could not write" message then says why.
export function assertWritable(root: string, file: string): void {
  const problem = linkProblem(root, file);
  if (problem !== undefined) {
    throw new Error(problem);
  }
}
