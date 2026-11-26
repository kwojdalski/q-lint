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
// Statements that switch the context are the strings of a list in that one
// string, each valued in the context the ones before it left (#3057).
//
// TorQ's `.gw.syncexec` on kdb+ 3.6 and later defers its reply (`-30!`), so
// what a lambda around it would answer is discarded: a gateway call is sent
// as a plain string, never inside q-lint's lambda (#2584).
import { qString } from "./qliteral";
import { contextSwitch, statements } from "./statements";

export const GATEWAY_COMMANDS = {
  set: "q-lint.setGatewayServerTypes",
  queryWith: "q-lint.queryGatewayWithServerTypes",
} as const;

/// Statements as they go to a process: on a TorQ gateway through
/// `.gw.syncexec`, `plain` when they are then a gateway call, which defers
/// its reply past any lambda of q-lint's, so goes as plain strings
/// (`Live.gatewayed`).
export type Gatewayed = (cut: string[]) => { cut: string[]; plain: boolean };

/// `q-lint.connection.torqGateway.enable`: whether a gateway's queries go
/// through `.gw.syncexec`, and its commands are offered.
export function readGateway(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("connection.torqGateway.enable", true) !== false };
}

/// The words of server types as typed - a string, split as
/// `processes.serverTypes` splits it, or a list - that are no q name, which
/// that drops: `hdb-eu` of `rdb hdb-eu`, `2hdb` of `rdb 2hdb` (#3065).
export function notServerTypes(value: string | readonly unknown[]): string[] {
  const words = typeof value === "string" ? value.split(/[\s,`]+/) : value.map((t) => (typeof t === "string" ? t.trim().replace(/^`/, "") : String(t)));
  return [...new Set(words.filter((t) => t !== "" && !/^[A-Za-z][A-Za-z0-9_.]*$/.test(t)))];
}

/// What to say of server types as typed when a word of them is no q name,
/// naming each; undefined when all are.
export function serverTypesProblem(value: string | readonly unknown[]): string | undefined {
  const bad = notServerTypes(value);
  return bad.length === 0 ? undefined : `Server types are q names: rdb hdb. ${bad.map((t) => `"${t}"`).join(", ")} ${bad.length === 1 ? "is not one" : "are not"}.`;
}

/// Server types as a q symbol list: one is enlisted.
export function symbols(types: string[]): string {
  return `${types.length === 1 ? "enlist " : ""}${types.map((t) => `\`${t}`).join("")}`;
}

/// `statements` as the one string a server `value`s to run them in order: a
/// system command as `system`, as `\d .ns` cannot be followed by more on
/// its line, and each after the first on a line of its own that starts
/// `" ;"`, so a trailing comment ends before it. With a `\d` among them
/// each is a string of its own, valued in turn: q parses one string whole,
/// so a function after `\d .ns` in it was bound to the root, and its call
/// of a function beside it failed, or found the root's (#3057).
export function joined(statements: string[]): string {
  const each = statements.map((s) => (s.startsWith("\\") ? `system ${qString(s.slice(1))}` : s));
  return each.length > 1 && statements.some((s) => contextSwitch(s) !== undefined) ? `last value each (${each.map(qString).join(";")})` : each.join("\n ;");
}

/// The one statement that runs `statements` through the gateway on a server
/// of each of `types`.
export function gatewayStatement(statements: string[], types: string[]): string {
  return `.gw.syncexec[${qString(statements.length === 1 ? statements[0] : joined(statements))};${symbols(types)}]`;
}

/// One `.gw.syncexec[query;types]` call of a string, as `gatewayStatement`
/// writes one: the call up to its types, the string, and the types.
const CALL = /^(\.gw\.syncexec\[(?:enlist )?"((?:[^"\\]|\\.)*)";)((?:enlist )?(?:`[A-Za-z][A-Za-z0-9_.]*)+)\]$/s;

/// `code` sent to `types` instead, when it is one `.gw.syncexec[query;types]`
/// call of a string, as a query is recorded in the history: Query Gateway
/// with Server Types does not keep the types it was recorded with (#2592).
/// Undefined for any other code.
export function withServerTypes(code: string, types: string[]): string | undefined {
  const cut = statements(code);
  const m = cut.length !== 1 ? null : CALL.exec(cut[0]);
  return m === null ? undefined : `${m[1]}${symbols(types)}]`;
}

/// The query and the server types of `code` when it is one
/// `.gw.syncexec[query;types]` call of a string - a result's code, as it was
/// sent - so what is built on the result runs on the servers it came from
/// (#2436, #2437). Undefined for any other code.
export function gatewayParts(code: string): { query: string; types: string[] } | undefined {
  const cut = statements(code);
  const m = cut.length !== 1 ? null : CALL.exec(cut[0]);
  if (m === null) {
    return undefined;
  }
  const bytes: number[] = [];
  const text = new TextEncoder().encode(m[2]);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== 0x5c) {
      bytes.push(text[i]);
      continue;
    }
    const next = String.fromCharCode(text[++i]);
    const octal = /^[0-7]{3}$/.test(String.fromCharCode(...text.slice(i, i + 3)));
    if (octal) {
      bytes.push(parseInt(String.fromCharCode(...text.slice(i, i + 3)), 8));
      i += 2;
    } else {
      bytes.push(next === "n" ? 10 : next === "r" ? 13 : next === "t" ? 9 : text[i]);
    }
  }
  const types = m[3].replace(/^enlist /, "").split("`").filter((t) => t !== "");
  return { query: new TextDecoder().decode(new Uint8Array(bytes)), types };
}

/// `statements` run through the gateway on a server of each of `types`,
/// what each answers joined by `join` - q the gateway applies to the list of
/// them - in place of the `raze` `.gw.syncexec` joins with: TorQ's
/// `.gw.syncexecj`.
export function gatewayJoined(statements: string[], types: string[], join: string): string {
  return `.gw.syncexecj[${qString(statements.length === 1 ? statements[0] : joined(statements))};${symbols(types)};${join}]`;
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

/// Whether `code` runs on a gateway itself, not on its servers: a gateway
/// call, or a read of the state every TorQ process keeps of its own, which
/// asked of a gateway is the gateway's - its discovery in `.servers`
/// (`.servers.SERVERS`, `.servers.getservers`), `.clients` and `.timer` -
/// or of `.kxdash`, which only a gateway loads (#3058). Not `.proc`:
/// `.proc.cp[]` in a where clause is a query for the servers. Such a read
/// defers no reply, so it is no gateway call, and goes as any query does.
export function isGatewayOwn(code: string): boolean {
  return statements(code).some(ownStatement);
}

function ownStatement(statement: string): boolean {
  return names(statement).some((n) => /^\.(gw|dataaccess|servers|clients|timer|kxdash)\./.test(n));
}

/// Which of `cut` run on the gateway itself: its own statements, and those
/// a name ties to one - `count t` after `t:.gw.syncexec[...]` (#2361), the
/// `t:\`trade` a later `.gw.syncexec[({select from x};t);...]` reads
/// (#1951) - which mean nothing on a server.
function onGateway(cut: string[]): boolean[] {
  const read = cut.map((s) => new Set(names(s)));
  const set = cut.map((s) => /^([A-Za-z.][A-Za-z0-9_.]*)[ \t]*[^ \t\w"`(\[{;:]?:/.exec(s)?.[1]);
  const own = cut.map(ownStatement);
  for (let more = true; more; ) {
    more = false;
    for (let i = 0; i < cut.length; i++) {
      const tied = (j: number): boolean => own[j] && (j < i ? set[j] !== undefined && read[i].has(set[j]) : set[i] !== undefined && read[j].has(set[i]!));
      if (!own[i] && contextSwitch(cut[i]) === undefined && cut.some((_, j) => j !== i && tied(j))) {
        own[i] = more = true;
      }
    }
  }
  return own;
}

/// `cut` as it goes to a gateway whose queries go to `types`, statement by
/// statement (#3059): the gateway's own as written, and each run of the
/// others as one `.gw.syncexec` call, so `n:count .gw.servers` above a
/// query does not keep the query from its servers. A `\d` holds on both
/// sides: it stays where it is for the gateway's statements, and heads each
/// call that follows it. With none of the gateway's own, one call of all.
export function gatewayStatements(cut: string[], types: string[]): string[] {
  const own = onGateway(cut);
  if (cut.length === 0 || !own.includes(true)) {
    return cut.length === 0 ? cut : [gatewayStatement(cut, types)];
  }
  if (cut.every((s, i) => own[i] || contextSwitch(s) !== undefined)) {
    return cut;
  }
  const out: string[] = [];
  let run: string[] = [];
  let context: string | undefined;
  const call = (): void => {
    if (run.length > 0) {
      out.push(gatewayStatement(context === undefined ? run : [context, ...run], types));
    }
    run = [];
  };
  cut.forEach((s, i) => {
    const to = contextSwitch(s);
    if (to === undefined && !own[i]) {
      run.push(s);
      return;
    }
    call();
    out.push(s);
    context = to === undefined ? context : to === "." ? undefined : s;
  });
  call();
  return out;
}

/// The server types a file names for its queries: a line at column 0
/// `/ @servertypes rdb hdb`, read to its first word that does not start as
/// a name or a number does - a comment after them is none (#2587). A word
/// that does but is no q name, `2hdb` or `hdb-eu`, is a type mistyped: it
/// is kept, for the query to be refused with its name, where the line cut
/// at it sent the query to the types before it only (#3065).
/// `/ @servertypes none` names no server, `[]`: the file's queries run on
/// the gateway itself (#2588). Undefined when it names none.
export function fileServerTypes(text: string): string[] | undefined {
  const m = /^\/[ \t]*@servertypes[ \t]+(.+)$/m.exec(text);
  if (m === null) {
    return undefined;
  }
  const words = m[1].split(/[\s,`]+/).filter((t) => t !== "");
  const end = words.findIndex((t) => !/^[A-Za-z0-9]/.test(t));
  const types = [...new Set(end < 0 ? words : words.slice(0, end))];
  if (types.length === 1 && types[0] === "none") {
    return [];
  }
  return types.length > 0 ? types : undefined;
}
