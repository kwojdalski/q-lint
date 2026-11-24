// The editor's side of three language server features (#994, #996, #997):
// the reference count lens's command, the names only the connected process
// defines in workspace symbol search, and the argument slot the cursor is
// in. Free of any `vscode` import, so node tests it; `editorassistview.ts`
// registers them.
//
// `PROCESS_NAMES` is sent as one lambda with the most names to send back,
// and changes nothing: it lists the root's and each namespace's functions
// (`\f`), variables (`\v`, tables marked by `\a`) and the root's views
// (`\b`) - the system commands list names without evaluating any, so a
// view is named and never run. A namespace inside a namespace is listed
// among its parent's variables: it is told by its value's first key, the
// null symbol, read from the parent without evaluating anything, and its
// own names are listed in its place, to any depth (#1910). One that cannot
// be listed stays a variable. One-letter namespaces (`.q`, `.Q`, `.z`,
// ...) are q's own and left out.
//
//   `name`kind!(names; kinds), each a list of strings

/// The command a reference count lens runs (`src/lsp/annotate.rs`).
export const SHOW_REFERENCES = "q-lint.showReferences";
/// The server's request for the argument slot at a position.
export const ARGUMENT_SLOT = "q-lint/argumentSlot";
/// The server's request for which names the workspace defines.
export const DEFINED_IN_WORKSPACE = "q-lint/defined";
/// The URI scheme a process-only symbol opens as.
export const PROCESS_SYMBOL_SCHEME = "q-lint-process-name";
/// The most names a process sends back.
export const NAMES_LIMIT = 20000;
/// The most process names one search adds.
export const SYMBOLS_LIMIT = 200;

export const PROCESS_NAMES = [
  "{[lim]",
  " lim:\"j\"$lim;",
  // q's own namespaces are left out by name: `.u`, a one-letter one of the
  // process's, is kept (#1261).
  " ns:{`$\".\",'string x} (key `) except ``q`Q`h`j`o`z`m`s;",
  " a:system\"a\";",
  " r:(`name`kind!(();()));",
  " add:{[r;n;k] r[`name],:string n; r[`kind],:count[n]#enlist k; r};",
  " r:add[r;system\"f\";\"function\"];",
  " v:system\"v\"; r:add[r;v where not v in a;\"variable\"]; r:add[r;v where v in a;\"table\"];",
  " r:add[r;system\"b\";\"view\"];",
  " one:{[add;lim;r;n] if[lim<=count r`name;:r]; q:\" \",string n; at:{[n;x] ` sv' n,'x}[n];",
  "  t:system\"a\",q; v:system\"v\",q; d:get n;",
  "  c:v where{$[99h=type x;$[11h=type k:key x;null first k;0b];0b]}each d v; v:v except c;",
  "  r:add[r;at system\"f\",q;\"function\"];",
  "  r:add[r;at v where not v in t;\"variable\"];",
  "  r:add[r;at v where v in t;\"table\"];",
  "  {[one;add;r;n] @[one[r];n;{[add;r;n;e] add[r;enlist n;\"variable\"]}[add;r;n]]}[.z.s[add;lim];add]/[r;at c]}[add;lim];",
  " r:{[one;r;n] @[one[r];n;{[r;e] r}[r]]}[one]/[r;ns];",
  " (lim&count r`name) sublist/: r}",
].join("\n");

export type ProcessKind = "function" | "variable" | "table" | "view";

export interface ProcessName {
  name: string;
  kind: ProcessKind;
}

const text = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.join("") : String(v ?? ""));
const KINDS = new Set<string>(["function", "variable", "table", "view"]);

/// What `PROCESS_NAMES` answered. Throws when it is not its answer.
export function readProcessNames(raw: unknown): ProcessName[] {
  const r = raw as { name?: unknown; kind?: unknown } | null;
  if (r === null || typeof r !== "object" || !Array.isArray(r.name) || !Array.isArray(r.kind) || r.name.length !== r.kind.length) {
    throw new Error(`the process answered something other than its names: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const out: ProcessName[] = [];
  r.name.forEach((n, i) => {
    const name = text(n);
    const kind = text((r.kind as unknown[])[i]);
    if (name !== "" && KINDS.has(kind)) {
      out.push({ name, kind: kind as ProcessKind });
    }
  });
  return out;
}

/// Whether the letters of `query` are in `name` in that order, in either
/// case: the loosest match VS Code makes, so nothing it would show is kept
/// from it. An empty query matches everything.
export function matches(query: string, name: string): boolean {
  const lower = name.toLowerCase();
  let at = 0;
  for (const c of query.toLowerCase()) {
    if (c === " ") {
      continue;
    }
    at = lower.indexOf(c, at);
    if (at < 0) {
      return false;
    }
    at += 1;
  }
  return true;
}

/// The names of `names` that match `query`, at most `limit`, shortest first.
export function matching(names: ProcessName[], query: string, limit = SYMBOLS_LIMIT): ProcessName[] {
  return names
    .filter((n) => matches(query, n.name))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/// The text a process-only symbol opens as: what is known of it without
/// asking the process again.
export function processSymbolDocument(name: string, kind: string, process: string): string {
  const article = kind === "function" ? "a function" : kind === "table" ? "a table" : kind === "view" ? "a view" : "a variable";
  const more =
    kind === "function"
      ? "/ q-lint: Open Function Source reads its text from the process.\n"
      : "/ No workspace file defines it; the Process Explorer shows its value.\n";
  return `/ ${name}: ${article} on ${process}, defined in no workspace file.\n${more}`;
}

/// A position as LSP writes one.
export interface LspPosition {
  line: number;
  character: number;
}

const isPosition = (v: unknown): v is LspPosition => {
  const p = v as { line?: unknown; character?: unknown } | null;
  const n = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0;
  return p !== null && typeof p === "object" && n(p.line) && n(p.character);
};

/// A reference lens's arguments, `[uri, position]`, when they are those.
export function lensTarget(uri: unknown, position: unknown): { uri: string; position: LspPosition } | undefined {
  return typeof uri === "string" && uri !== "" && isPosition(position) ? { uri, position: { line: position.line, character: position.character } } : undefined;
}

/// One argument slot, as `q-lint/argumentSlot` answers it.
export interface Slot {
  range: { start: LspPosition; end: LspPosition };
  index: number;
  callee: string;
  parameter?: string;
  hinted: boolean;
}

/// What `q-lint/argumentSlot` answered, when it is a slot.
export function readSlot(raw: unknown): Slot | undefined {
  const r = raw as { range?: { start?: unknown; end?: unknown }; index?: unknown; callee?: unknown; parameter?: unknown; hinted?: unknown } | null;
  if (r === null || typeof r !== "object" || !isPosition(r.range?.start) || !isPosition(r.range?.end) || typeof r.index !== "number") {
    return undefined;
  }
  return {
    range: { start: r.range.start, end: r.range.end },
    index: r.index,
    callee: typeof r.callee === "string" ? r.callee : "",
    ...(typeof r.parameter === "string" && r.parameter !== "" ? { parameter: r.parameter } : {}),
    hinted: r.hinted === true,
  };
}

/// The label drawn before a slot: its parameter's name, unless an inlay
/// hint already draws it there.
export function slotLabel(slot: Slot): string | undefined {
  return slot.parameter !== undefined && !slot.hinted ? `${slot.parameter}:` : undefined;
}

/// The hover a slot's highlight carries.
export function slotHover(slot: Slot): string {
  const which = `argument ${slot.index + 1} of ${slot.callee}`;
  return slot.parameter === undefined ? which : `${which}: ${slot.parameter}`;
}
