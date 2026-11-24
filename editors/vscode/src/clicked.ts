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

/// Whether `uri` is open in an editor with unsaved edits: a file written
/// under it conflicts with the next save, and one side is lost (#1531).
export function unsavedIn(uri: { toString(): string }, documents: readonly { uri: { toString(): string }; isDirty: boolean }[]): boolean {
  const key = uri.toString();
  return documents.some((d) => d.isDirty && d.uri.toString() === key);
}

/// The files of an Explorer multi-selection: VS Code hands a command the
/// file clicked, then `selected`, every file selected. Undefined for one
/// file or none, where the command runs as for the one clicked (#1541).
export function selectedMany<U extends { scheme: string; toString(): string }>(selected: unknown): U[] | undefined {
  return Array.isArray(selected) && selected.length > 1 && selected.every(isUriLike) ? (selected as U[]) : undefined;
}
