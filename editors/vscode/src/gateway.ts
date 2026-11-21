// TorQ gateways (#909): a query to a process marked as one goes as
// `.gw.syncexec[query;servertypes]`, which runs it on a server of each type
// and joins what they answer. No `vscode` import, so node tests it.
//
// One statement goes as a string, as a TorQ user writes a gateway query.
// Several go as `({last value each x};statements)`, which each server applies
// as its `.z.pg` values any sync message: q's `value` of one string does not
// take a newline or a trailing comment as the end of a statement, so they are
// not joined into one.
import { qString } from "./qliteral";

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

/// The one statement that runs `statements` through the gateway on a server
/// of each of `types`.
export function gatewayStatement(statements: string[], types: string[]): string {
  const query =
    statements.length === 1 ? qString(statements[0]) : `({last value each x};(${statements.map(qString).join(";")}))`;
  return `.gw.syncexec[${query};${symbols(types)}]`;
}

/// Whether `code` is already a gateway call: a query run again from the
/// history was recorded as it was sent, and is not wrapped twice.
export function isGatewayCall(code: string): boolean {
  return /^\s*\.gw\.(syncexec|asyncexec)\b/.test(code);
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
