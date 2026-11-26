// The undefined-name check's data (#945): the globals a document reads that
// no workspace file defines (the language server's `q-lint/unresolvedNames`)
// and which of them the connected process does not define either. Free of
// any `vscode` import, so a test can drive it; `undefinednamesview.ts`
// publishes the diagnostics.
//
// `DEFINED` is sent as one lambda with the names, space-separated (a
// one-character string reaches q as a char), and answers a boolean for each:
// whether its namespace's `key` holds it - or a table's columns, `t.c`
// (#2808) - or, for a bare name, the root's or `.q`'s, where q also looks.
// Nothing is evaluated, and nothing is defined.

/// The command that checks the active file now.
export const CHECK_UNDEFINED = "q-lint.checkUndefinedNames";

export const DEFINED = [
  "{[ns]",
  " {[n] s:` vs n; @[{[s;n] $[1=count s;(n in key `.) or n in key `.q;(last s) in $[98h=type v:get p:` sv -1_s;cols v;key p]]}[s];n;0b]} each `$\" \" vs (),ns}",
].join("\n");

/// One global the server found no definition of: each name q may resolve
/// it to, as it is written, and where.
export interface Unresolved {
  names: string[];
  written: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const NAME = /^\.?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

const position = (v: unknown): v is { line: number; character: number } => {
  const p = v as { line?: unknown; character?: unknown } | null;
  return p !== null && typeof p === "object" && typeof p.line === "number" && typeof p.character === "number";
};

/// What `q-lint/unresolvedNames` answered, keeping what is well formed.
export function readUnresolved(raw: unknown): Unresolved[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as Record<string, unknown>[])
    .filter(
      (u) =>
        u !== null &&
        typeof u === "object" &&
        typeof u.written === "string" &&
        Array.isArray(u.names) &&
        u.names.length > 0 &&
        u.names.every((n) => typeof n === "string" && NAME.test(n)) &&
        position((u.range as { start?: unknown } | undefined)?.start) &&
        position((u.range as { end?: unknown } | undefined)?.end),
    )
    .map((u) => ({ names: u.names as string[], written: u.written as string, range: u.range as Unresolved["range"] }));
}

/// Each name to ask about, once.
export function namesToAsk(found: Unresolved[]): string[] {
  return [...new Set(found.flatMap((u) => u.names))];
}

/// The booleans `DEFINED` answered, one per name asked. Throws when it is
/// not its answer.
export function readDefined(raw: unknown, asked: string[]): Map<string, boolean> {
  const list = Array.isArray(raw) ? raw : typeof raw === "boolean" ? [raw] : undefined;
  if (list === undefined || list.length !== asked.length || !list.every((b) => typeof b === "boolean")) {
    throw new Error(`the process answered something other than which names it defines: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return new Map(asked.map((name, i) => [name, list[i] as boolean]));
}

/// The globals neither the workspace nor the process defines: those of
/// `found` none of whose names the process has.
export function undefinedOnProcess(found: Unresolved[], defined: Map<string, boolean>): Unresolved[] {
  return found.filter((u) => u.names.every((name) => defined.get(name) === false));
}

/// What the diagnostic says.
export function undefinedMessage(u: Unresolved, process: string): string {
  const name = u.names.length === 1 ? u.names[0] : u.written;
  return `${name} is defined neither in the workspace nor on ${process}`;
}
