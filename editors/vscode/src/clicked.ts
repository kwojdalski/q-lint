// The editor a command was run for. A button in an editor's title bar hands
// the command that editor's Uri and does not focus its group, so the active
// editor can be another one (#1523). No `vscode` import: tested in node.

type Shown = { document: { uri: { toString(): string } } };

/// Whether `value` looks like a Uri: what a menu hands a command.
export function isUriLike(value: unknown): value is { scheme: string; toString(): string } {
  return typeof value === "object" && value !== null && typeof (value as { scheme?: unknown }).scheme === "string";
}

/// The editor showing `given`, a Uri a menu handed in - the active one when
/// it shows it - else the active editor, as for a keybinding.
export function clickedEditor<E extends Shown>(given: unknown, visible: readonly E[], active: E | undefined): E | undefined {
  if (!isUriLike(given)) {
    return active;
  }
  const uri = given.toString();
  if (active?.document.uri.toString() === uri) {
    return active;
  }
  return visible.find((e) => e.document.uri.toString() === uri) ?? active;
}
