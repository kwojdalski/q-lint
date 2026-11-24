// Writes into a workspace folder, which may be a repository from anywhere
// (#1830). A file or folder the repository ships as a symbolic link would
// take a write elsewhere: `qlinter-baseline.json` linked to `~/.zshrc` was
// replaced by Write Lint Baseline, and a dangling link made the "never over
// a file" checks see nothing there and create the file it points at. No
// `vscode` import, so node tests it.
import * as fs from "node:fs";
import * as path from "node:path";

/// Why `file` is not written as a file of `root`, or undefined when it may
/// be: `file` outside `root`, or a symbolic link at it or at a folder on the
/// way to it from `root` (`root` itself may be one). What does not exist yet
/// is made by the write, so the walk stops there.
export function linkProblem(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
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
  const inside = folders.filter((f) => {
    const rel = path.relative(f, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
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
