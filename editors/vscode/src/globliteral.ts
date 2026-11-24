// A file name as a glob that matches only itself. `[1]` in `f[1].q` is a
// character class to a glob and `{a}` a brace group, so a file named so was
// never found (#1526). No `vscode` import: tested in node.

/// `name` with each glob character - `[ ] { } * ?` - in brackets of its own,
/// as VS Code's glob (and minimatch) read `[[]` as a literal `[`.
export function globLiteral(name: string): string {
  return name.replace(/[[\]{}*?]/g, "[$&]");
}
