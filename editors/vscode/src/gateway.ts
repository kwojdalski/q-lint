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

/// The names and symbols `statement` spells outside its strings and
/// comments (a `/` at its start or after a blank, to the end of the line).
function names(statement: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < statement.length) {
    const c = statement[i];
    if (c === '"') {
      i++;
      while (i < statement.length && statement[i] !== '"') {
        i += statement[i] === "\\" ? 2 : 1;
      }
      i++;
    } else if (c === "/" && (i === 0 || /[ \t\n\r]/.test(statement[i - 1]))) {
      while (i < statement.length && statement[i] !== "\n") {
        i++;
      }
    } else if (/[A-Za-z.`]/.test(c)) {
      const m = /^`?[A-Za-z.][A-Za-z0-9_.]*/.exec(statement.slice(i));
      if (m === null) {
        i++;
        continue;
      }
      out.push(m[0].replace(/^`/, ""));
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      // A number's letters are no name: `2024.01.01D`, `0Wj`.
      while (i < statement.length && /[0-9A-Za-z._:]/.test(statement[i])) {
        i++;
      }
    } else {
      i++;
    }
  }
  return out;
}

/// Whether `code` is the gateway's own code, sent as it is: a call of
/// `.gw.syncexec` or `.gw.asyncexec` - TorQ's variants (`.gw.syncexecj`,
/// `.gw.asyncexecjpt`) too, as the guard's GATEWAY_EXEC reads them (#1427) -
/// anywhere in any of its statements, as `t:.gw.syncexec[...]` (#2361) or
/// under a comment (#1951), or a read of the gateway's API and state, in
/// `.gw` or `.dataaccess` (`.dataaccess.getdata` routes and joins on the
/// gateway, #2588). A query run again from the history was recorded as it
/// was sent, so it is not wrapped twice.
export function isGatewayCall(code: string): boolean {
  return statements(code).some((s) => names(s).some((n) => /^\.(gw|dataaccess)\./.test(n)));
}

/// The server types a file names for its queries: a line at column 0
/// `/ @servertypes rdb hdb`. `/ @servertypes none` names no server, `[]`:
/// the file's queries run on the gateway itself (#2588). Undefined when it
/// names none.
export function fileServerTypes(text: string): string[] | undefined {
  const m = /^\/[ \t]*@servertypes[ \t]+(.+)$/m.exec(text);
  if (m === null) {
    return undefined;
  }
  const types = [...new Set(m[1].split(/[\s,`]+/).filter((t) => /^[A-Za-z][A-Za-z0-9_.]*$/.test(t)))];
  if (types.length === 1 && types[0] === "none") {
    return [];
  }
  return types.length > 0 ? types : undefined;
}
