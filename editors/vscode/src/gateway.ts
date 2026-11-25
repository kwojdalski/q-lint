// TorQ gateways (#909): a query to a process marked as one goes as
// `.gw.syncexec[query;servertypes]`, which runs it on a server of each type
// and joins what they answer. No `vscode` import, so node tests it.
//
// The query goes as one string, as a TorQ user writes a gateway query: each
// server `value`s it, or under TorQ's read-only mode `reval parse`s it, which
// refuses anything but a string (#2591), and a permissioned gateway may refuse
// anything of q-lint's (#2492). Several statements are joined into that one
// string: q's `value` does not take a newline as the end of a statement, but
// it reads a `;` on a continuation line as one, after a trailing comment too.
//
// TorQ's `.gw.syncexec` on kdb+ 3.6 and later defers its reply (`-30!`), so
// what a lambda around it would answer is discarded: a gateway call is sent
// as a plain string, never inside q-lint's lambda (#2584).
import { qString } from "./qliteral";
import { statements } from "./statements";

export const GATEWAY_COMMANDS = {
  set: "q-lint.setGatewayServerTypes",
  queryWith: "q-lint.queryGatewayWithServerTypes",
} as const;

/// `q-lint.connection.torqGateway.enable`: whether a gateway's queries go
/// through `.gw.syncexec`, and its commands are offered.
export function readGateway(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("connection.torqGateway.enable", true) !== false };
}

/// Server types as a q symbol list: one is enlisted.
export function symbols(types: string[]): string {
  return `${types.length === 1 ? "enlist " : ""}${types.map((t) => `\`${t}`).join("")}`;
}

/// `statements` as the one string a server `value`s to run them in order: a
/// system command as `system`, as `\d .ns` cannot be followed by more on
/// its line, and each after the first on a line of its own that starts
/// `" ;"`, so a trailing comment ends before it.
export function joined(statements: string[]): string {
  return statements.map((s) => (s.startsWith("\\") ? `system ${qString(s.slice(1))}` : s)).join("\n ;");
}

/// The one statement that runs `statements` through the gateway on a server
/// of each of `types`.
export function gatewayStatement(statements: string[], types: string[]): string {
  return `.gw.syncexec[${qString(statements.length === 1 ? statements[0] : joined(statements))};${symbols(types)}]`;
}

/// Whether `code` is already a gateway call: a query run again from the
/// history was recorded as it was sent, and is not wrapped twice. TorQ's
/// variants (`.gw.syncexecj`, `.gw.asyncexecjpt`) count, as the guard's
/// GATEWAY_EXEC reads them (#1427). Any of its statements may be the call:
/// one under a comment, or after another statement, is one too (#1951).
export function isGatewayCall(code: string): boolean {
  return statements(code).some((s) => /^\s*\.gw\.(syncexec|asyncexec)[A-Za-z]*\b/.test(s));
}

/// The server types a file names for its queries: a line at column 0
/// `/ @servertypes rdb hdb`. Undefined when it names none.
export function fileServerTypes(text: string): string[] | undefined {
  const m = /^\/[ \t]*@servertypes[ \t]+(.+)$/m.exec(text);
  if (m === null) {
    return undefined;
  }
  const types = [...new Set(m[1].split(/[\s,`]+/).filter((t) => /^[A-Za-z][A-Za-z0-9_.]*$/.test(t)))];
  return types.length > 0 ? types : undefined;
}
