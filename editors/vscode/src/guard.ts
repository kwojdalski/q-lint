// The read-only guard (#918), as data: which processes it guards, and what
// in a piece of q code would change one. No `vscode` import, so node tests
// it; `live.ts` asks the user, for every path that sends code to a process.
//
// A process is guarded when it carries a tag `q-lint.processes.readOnlyGuard.tags`
// names (`prod`, `prd` and `production` by default). Code sent to one is read
// first, and when it would assign a global, delete or change a table in
// place, write a file, or run a system command, the user is asked before it
// is sent. What is read is the text: a lambda defined earlier that writes,
// or a string built at run time and evaluated, is not seen. The guard is a
// check against a slip, not a permission system - a process that must not
// be changed needs its own `.z.pg`.
//
// The rules, outside strings and comments:
// - `name:`, `name::`, `name+:` and `name[i]:` at the top level, and
//   `name::`, a dotted `.ns.name:`, or `name+:` or `name[i]:` to a name that
//   is not one of its locals inside a lambda, where q makes them global.
//   A column named in `select a:x from t` or `([] a:1 2)` is not an
//   assignment, but one inside a column's expression (`([] c:g:1)`) is;
//   `(a;b):x` assigns each name, by the same rules;
// - `update` or `delete` from a table named by a symbol (`` from `t ``,
//   `` from (`t) ``), which changes it in place;
// - `set`, `upsert`, `insert`, `hdel`, `exit`, `hclose`, `system`,
//   `setenv`, `save`, `rsave`, `dsave`, `load`, `rload`, `.Q.dpft`,
//   `.Q.dpfts`, `.Q.dpt`, `.Q.dpts`, `.Q.hdpf`, `.Q.en`, `.Q.ens`,
//   `.Q.enx`, `.Q.enxs`, `.Q.chk`, `.Q.dsftg`, `.Q.view`, `.Q.l`, `.Q.lo`,
//   `.Q.bv` and `.Q.opt` (which sets `.Q.x`), and `0:` or `1:` to a
//   file handle (`` `:f 0: ``, `hsym[`f] 0:`, `(hsym `f) 1:`,
//   `` (`$":f") 0: ``, `` 0:[`:f;x] ``, `` .[0:;(`:f;x)] ``), and `2:`,
//   each also by its `.q.` name (`.q.set`), by its symbol
//   (`` `.q.set . (`a;1) ``) and indexed (`` .q[`set] ``) - `system` of a string literal
//   is read as that command, so `system "c"` only reads; `hopen` of a file handle
//   (`` hopen `:f ``, `` hopen hsym `f ``, `` hopen `$":f" ``, `hopen ":f"`),
//   which creates the file to write through - of a
//   process (`` `:host:5000 ``, a port) it only connects, and what is sent
//   over that handle is not read;
// - `xasc`, `xdesc` or `xkey` on a table named by a symbol
//   (`` `a xasc `t ``), which sorts or keys it in place;
// - `?` with a symbol atom on its left (`` `sym?`x ``), which extends that
//   enumeration, and the sym file when the symbol is a handle;
// - a string sent to handle 0 (`0"a:1"`, `neg[0]"a:1"`), which the
//   process evaluates itself;
// - `-11!`, which replays a log through `upd`, except `-11!(-1;..)` and
//   `-11!(-2;..)`, which only count and check one; `-19!`, which
//   compresses a file into another - each also spaced or with the number
//   in parentheses (`-19 !x`, `(-19)!x`);
// - `@[` or `.[` on a variable named by a symbol, alone or in
//   parentheses (`` .[(`t);..] ``), with four arguments: an
//   amend in place (three is as often a trap, `.[`f;args;handler]`, and
//   is not taken for one, unless the third is an attribute or a unary
//   that maps the items, `` @[`t;`c;`p#] ``, `` @[`t;`a;neg] ``); `![`
//   likewise, a functional update or delete. Also with the target left
//   out and given after (`` @[;`a;:;1] `. ``), and the amend or `!`
//   passed as a value (`` .[@;(`.;`a;:;1)] ``, `` (@) . (`.;..) ``);
// - `value`, `get`, `eval` or `-6!` applied to a string, to `parse` or
//   `-5!`, or to a tree headed by `:`, `::` or `+:` (`eval(:;`t;())`), by
//   `!` on a table by name (`` eval(!;enlist`t;..) ``, `` value(!;`t;..) ``)
//   or by the symbol of
//   a writer above (`` value(`.q.set;`a;1) ``), also through `[`,
//   `each`, `'`, `@`, `.` or `enlist`, in parentheses (`(value)"a:1"`)
//   and through a trap (`@[value;"a:1";h]`), and by their `.q.` names;
// - a system command (`\l`, `\cd x`, `\\`), except one that only reads a
//   setting (`\c`, `\d`, `\P`, `\_`, `\r`, `\E` without an argument, and
//   `\w 0` or `\w 1`) and `\t` or `\ts`, whose
//   expression is read by these rules - but `\t 500`, a whole number with
//   no `:N`, sets the timer;
// - any of these in a string given to a TorQ gateway's `.gw.syncexec` or
//   `.gw.asyncexec`, in brackets or applied (`.gw.syncexec . (q;`rdb)`),
//   which runs it on the gateway's servers (#909).
import type { Process } from "./processes";
import { statements } from "./statements";

export interface GuardSettings {
  enabled: boolean;
  /// Lower case.
  tags: string[];
}

export const DEFAULT_GUARD_TAGS = ["prod", "prd", "production"];

/// The settings read as `readLive` reads the query ones, at each send. A
/// tag list that is not a list of strings is the default one; an empty
/// list guards nothing.
export function readGuard(get: <T>(key: string, fallback: T) => T): GuardSettings {
  const tags = get<unknown>("processes.readOnlyGuard.tags", DEFAULT_GUARD_TAGS);
  return {
    enabled: get<unknown>("processes.readOnlyGuard.enable", true) !== false,
    tags:
      Array.isArray(tags) && tags.every((t) => typeof t === "string")
        ? [...new Set(tags.map((t: string) => t.trim().toLowerCase()).filter((t) => t !== ""))]
        : DEFAULT_GUARD_TAGS,
  };
}

/// The tags of `process` the guard guards it by; empty when it is not
/// guarded, or the guard is off.
export function guardedBy(process: Pick<Process, "tags">, settings: GuardSettings): string[] {
  if (!settings.enabled) {
    return [];
  }
  return process.tags.filter((tag) => settings.tags.includes(tag.trim().toLowerCase()));
}

type Kind = "name" | "sym" | "str" | "num" | "op" | "open" | "close" | "space";
interface Token {
  kind: Kind;
  text: string;
}

const NAME_START = /[A-Za-z.]/;
const NAME = /[A-Za-z0-9_.]/;
/// The characters that make a compound assignment with `:` after them.
const OPERATORS = new Set([..."+-*%&|^=<>$,#_~!?@."]);
const WRITERS = new Set([
  "set", "upsert", "insert", "hdel", "exit", "hclose", "system", "save", "rsave", "dsave", "load", "rload", "setenv",
  ".Q.dpft", ".Q.dpfts", ".Q.dpt", ".Q.dpts", ".Q.hdpf", ".Q.en", ".Q.ens", ".Q.enx", ".Q.enxs", ".Q.chk", ".Q.dsftg",
  ".Q.view", ".Q.l", ".Q.lo", ".Q.bv", ".Q.opt",
]);
/// System commands that only read a setting when they are given no argument.
const READS_BARE = new Set([..."abBcCdeEfgoOpPrsSTvwWz_", "cd"]);

/// The tokens of one statement: strings and symbols whole, a comment (a `/`
/// after a space, to the end of its line) dropped.
function tokens(code: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') {
        j += code[j] === "\\" ? 2 : 1;
      }
      out.push({ kind: "str", text: code.slice(i, j + 1) });
      i = j + 1;
    } else if (c === "/" && (i === 0 || /\s/.test(code[i - 1]))) {
      while (i < code.length && code[i] !== "\n") {
        i++;
      }
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < code.length && /\s/.test(code[j])) {
        j++;
      }
      out.push({ kind: "space", text: code.slice(i, j) });
      i = j;
    } else if (c === "`") {
      let j = i + 1;
      const path = code[j] === ":";
      while (j < code.length && (/[A-Za-z0-9_.:]/.test(code[j]) || (path && code[j] === "/"))) {
        j++;
      }
      out.push({ kind: "sym", text: code.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(code[i + 1] ?? "") && (out.length === 0 || out[out.length - 1].kind !== "name"))) {
      let j = i + 1;
      while (j < code.length && /[0-9A-Za-z.]/.test(code[j])) {
        j++;
      }
      out.push({ kind: "num", text: code.slice(i, j) });
      i = j;
    } else if (NAME_START.test(c) && !(c === "." && !NAME_START.test(code[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < code.length && NAME.test(code[j])) {
        j++;
      }
      out.push({ kind: "name", text: code.slice(i, j) });
      i = j;
    } else if ("([{".includes(c)) {
      out.push({ kind: "open", text: c });
      i++;
    } else if (")]}".includes(c)) {
      out.push({ kind: "close", text: c });
      i++;
    } else {
      out.push({ kind: "op", text: c });
      i++;
    }
  }
  return out;
}

/// The TorQ gateway calls that run a query string on the gateway's servers.
const GATEWAY_EXEC = /^\.gw\.(syncexec|asyncexec)[A-Za-z]*$/;

/// The text of the q string literal `literal`, quotes and escapes taken off.
function qText(literal: string): string {
  return literal
    .slice(1, literal.endsWith('"') && literal.length > 1 ? -1 : undefined)
    .replace(/\\([0-7]{3}|.)/g, (_, c: string) =>
      c.length === 3 ? String.fromCharCode(parseInt(c, 8)) : c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
    );
}

/// Whether the left argument of `0:` or `1:`, ending at `t[end]`, makes a
/// file handle: `hsym `f`, `hsym[`f]`, `(hsym `f)` or `` (`:f) ``. A
/// parse format, `("SJ";",")`, does not.
function computedHandle(t: Token[], end: number): boolean {
  if (t[end]?.kind === "sym") {
    return t[end - 1]?.text === "hsym";
  }
  if (t[end]?.kind !== "close") {
    return false;
  }
  let depth = 0;
  let open = end;
  for (; open >= 0; open--) {
    if (t[open].kind === "close") depth++;
    else if (t[open].kind === "open" && --depth === 0) break;
  }
  if (open < 0) {
    return false;
  }
  const inside = t.slice(open + 1, end);
  return t[open - 1]?.text === "hsym" || (t[open].text === "(" && (inside.some((k) => k.text === "hsym") || (inside.length === 1 && inside[0].kind === "sym" && inside[0].text.startsWith("`:")) || castHandle(inside, 0)));
}

/// Whether `t[i]` starts a handle cast from a string, `` `$":f" ``.
function castHandle(t: Token[], i: number): boolean {
  return t[i]?.text === "`" && t[i + 1]?.text === "$" && t[i + 2]?.kind === "str" && t[i + 2].text.startsWith('":');
}

/// Where the items of the bracket or parenthesis that opens at `t[open]`
/// start and end, `[start, end)` each, the last ending at its close.
function items(t: Token[], open: number): [number, number][] {
  const out: [number, number][] = [];
  let start = open + 1;
  let depth = 0;
  for (let j = open + 1; j < t.length; j++) {
    if (t[j].kind === "open") depth++;
    else if (t[j].kind === "close") {
      if (depth-- === 0) {
        out.push([start, j]);
        return out;
      }
    } else if (depth === 0 && t[j].text === ";") {
      out.push([start, j]);
      start = j + 1;
    }
  }
  out.push([start, t.length]);
  return out;
}

/// The unaries that, as an amend's third argument, change the items in place
/// rather than handle an error: `` @[`t;`a;neg] ``.
const UNARY = new Set([
  "neg", "not", "abs", "reverse", "asc", "desc", "distinct", "floor", "ceiling", "sqrt", "exp", "log",
  "reciprocal", "signum", "upper", "lower", "trim", "ltrim", "rtrim", "null", "fills", "sums", "deltas",
]);

/// `name` without the `.q.` that names a builtin as well: `.q.set` is `set`.
function unqualified(name: string): string {
  return name.startsWith(".q.") ? name.slice(3) : name;
}

/// The symbol at `t[i]`, alone or in parentheses: `` `t `` and `` (`t) ``
/// both name the table `t`.
function symbolAt(t: Token[], i: number): string | undefined {
  let open = 0;
  while (t[i + open]?.text === "(" && t[i + open]?.kind === "open") {
    open++;
  }
  const k = t[i + open];
  if (k?.kind !== "sym") {
    return undefined;
  }
  for (let n = 1; n <= open; n++) {
    if (t[i + open + n]?.text !== ")") {
      return undefined;
    }
  }
  return k.text;
}

/// Whether the handle symbol `sym` names a file rather than a process:
/// `` `:/tmp/x `` and `` `:x.txt `` do; `` `:host:5000 ``, `` `::5000 `` and
/// `` `:unix://5000 `` do not.
function isFileHandle(sym: string): boolean {
  return sym.startsWith("`:") && !/^`:(unix:\/\/\d|tcps?:\/\/|[^:/]*:\d)/.test(sym);
}

/// The locals of the lambda that opens at `t[open]`: its parameters (`x`,
/// `y` and `z` when it names none) and every name its body assigns with a
/// plain `:`, outside the lambdas nested in it.
function lambdaLocals(t: Token[], open: number, touching: (a: Token | undefined, b: Token | undefined) => boolean): Set<string> {
  const out = new Set<string>();
  let i = open + 1;
  if (t[i]?.text === "[" && t[i].kind === "open") {
    for (i++; i < t.length && t[i].text !== "]"; i++) {
      if (t[i].kind === "name") out.add(t[i].text);
    }
    i++;
  } else {
    ["x", "y", "z"].forEach((n) => out.add(n));
  }
  let depth = 0;
  let nested = 0;
  for (; i < t.length; i++) {
    const k = t[i];
    if (k.kind === "open") {
      depth++;
      nested += nested > 0 || k.text === "{" ? 1 : 0;
    } else if (k.kind === "close") {
      if (depth-- === 0) break;
      nested -= nested > 0 ? 1 : 0;
    } else if (nested === 0 && k.kind === "name" && t[i + 1]?.kind === "op" && t[i + 1].text === ":" && !(t[i + 2]?.text === ":" && touching(t[i + 1], t[i + 2]))) {
      out.add(k.text);
    } else if (nested === 0 && k.kind === "name" && (t[i - 1]?.text === "(" || t[i - 1]?.text === ";")) {
      // A name in a destructuring list, `(a;b):x`, is assigned as well.
      let j = i;
      while (t[j]?.kind === "name" && t[j + 1]?.text === ";") j += 2;
      if (t[j]?.kind === "name" && t[j + 1]?.text === ")" && t[j + 2]?.text === ":" && t[j + 2].kind === "op") {
        out.add(k.text);
      }
    }
  }
  return out;
}

/// What an evaluator - `value`, `get`, `eval` - applied to what starts at
/// `t[j]` would run that changes the process, and where that is; past
/// brackets, `each`, `'`, `@`, `.` and `enlist`. `byValue` when it is
/// `value` or `get`, which take a list's items as they are, so a symbol in
/// it names a table where `eval` would read the variable: `` value(!;`t;..) ``
/// and `` eval(!;enlist`t;..) `` both update `t` in place.
function evaluated(t: Token[], j: number, byValue: boolean): { reason: string; at: number } | undefined {
  while (
    t[j] !== undefined &&
    ((t[j].kind === "open" && t[j].text !== "{") ||
      (t[j].kind === "name" && ["each", "peach", "enlist"].includes(t[j].text)) ||
      (t[j].kind === "op" && ["'", "@", "."].includes(t[j].text)))
  ) {
    j++;
  }
  const k = t[j];
  const head = t[j - 1]?.text === "(" && t[j - 1]?.kind === "open";
  const reason = k?.kind === "str"
    ? "a string"
    : (k?.kind === "name" && k.text === "parse") || (k?.text === "-5" && t[j + 1]?.text === "!")
      ? "a parse tree"
      : head && k?.kind === "op" && (k.text === ":" || (OPERATORS.has(k.text) && t[j + 1]?.text === ":"))
        ? "an assignment"
        : head && k?.text === "!" && t[j + 1]?.text === ";" && (byValue ? t[j + 2] : t[j + 2]?.text === "enlist" ? t[j + 3] : undefined)?.kind === "sym"
          ? "a functional update or delete"
          : head && k?.kind === "sym" && WRITERS.has(unqualified(k.text.slice(1)))
            ? `a call of ${k.text.slice(1)}`
            : undefined;
  return reason === undefined ? undefined : { reason, at: j };
}

/// What one statement does that the guard asks about, added to `found`.
function readStatement(statement: string, found: Set<string>): void {
  const text = statement.trimStart();
  if (text.startsWith("\\")) {
    const command = /^\\(\\|[A-Za-z_]+)(?::\d+)?\s*([\s\S]*)$/.exec(text);
    const name = command?.[1] ?? "";
    const argument = (command?.[2] ?? "").trim();
    if (name === "t" && !text.startsWith("\\t:") && /^\d+$/.test(argument)) {
      found.add("sets the timer with \\t");
    } else if (name === "t" || name === "ts") {
      readStatement(argument, found);
    } else if (!(argument === "" && READS_BARE.has(name)) && !(name === "w" && /^[01]$/.test(argument))) {
      // (`\w 0` and `\w 1` report the symbols; another number sets the limit.)
      found.add(`runs the system command \\${name}`);
    }
    return;
  }
  const all = tokens(statement);
  // Where each token stands among all of them: `a::` is a global
  // assignment, `a: :` is not one.
  const at = new Map(all.map((k, i) => [k, i]));
  const touching = (a: Token | undefined, b: Token | undefined): boolean =>
    a !== undefined && b !== undefined && at.get(b) === (at.get(a) ?? -2) + 1;
  const t = all.filter((k) => k.kind !== "space");
  // What each open bracket is: a lambda, a table literal, its key columns'
  // `[`, or none of them.
  const stack: ("lambda" | "table" | "key" | "other")[] = [];
  let lambdas = 0;
  // The locals of each lambda open around the token: its parameters and the
  // names it assigns plainly anywhere in its body, as q compiles it.
  const locals: Set<string>[] = [];
  // Between `select`, `exec`, `update` or `delete` and its `from`, a name
  // before `:` names a column.
  let qsql: string | undefined;
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    const next = t[i + 1];
    if (k.kind === "open") {
      const kind =
        k.text === "{"
          ? "lambda"
          : k.text === "(" && next?.text === "["
            ? "table"
            : k.text === "[" && stack[stack.length - 1] === "table" && t[i - 1]?.text === "("
              ? "key"
              : "other";
      stack.push(kind);
      lambdas += kind === "lambda" ? 1 : 0;
      if (kind === "lambda") {
        locals.push(lambdaLocals(t, i, touching));
      }
      // `(a;b):x` assigns each name, globally at the top level.
      if (k.text === "(") {
        const names: string[] = [];
        let j = i + 1;
        while (t[j]?.kind === "name" && (t[j + 1]?.text === ";" || t[j + 1]?.text === ")")) {
          names.push(t[j].text);
          j += 2;
          if (t[j - 1].text === ")") break;
        }
        if (names.length > 1 && t[j - 1]?.text === ")" && t[j]?.kind === "op" && t[j].text === ":" && qsql === undefined) {
          const global = t[j + 1]?.text === ":" && touching(t[j], t[j + 1]);
          for (const name of names) {
            if (lambdas === 0 || global || name.includes(".")) {
              found.add(`assigns ${name}`);
            }
          }
        }
      }
      const amend = t[i - 1]?.kind === "op" ? t[i - 1].text : "";
      if (k.text === "[" && (amend === "@" || amend === "." || amend === "!")) {
        const args = items(t, i);
        // The target, or with it left out, what the projection is applied
        // to: `` @[;`a;:;1] `. ``, `` .[;();:;5][`a] ``.
        const close = args.length > 0 ? args[args.length - 1][1] : -1;
        const target =
          args[0]?.[0] !== args[0]?.[1]
            ? symbolAt(t, i + 1)
            : t[close + 1]?.text === "[" && t[close + 1].kind === "open"
              ? symbolAt(t, close + 2)
              : symbolAt(t, close + 1);
        // Three is a trap as often as an amend, `.[`f;args;handler]`, unless
        // the third is a unary that sets an attribute or maps the items:
        // `` @[`t;`c;`p#] ``, `` @[`t;`a;neg] ``.
        const third = args.length === 3 ? t.slice(args[2][0], args[2][1]) : [];
        const unary =
          amend !== "!" &&
          ((third.length === 2 && third[0].kind === "sym" && third[1].text === "#") ||
            (third.length === 1 && third[0].kind === "name" && UNARY.has(third[0].text)));
        if (target !== undefined && target.length > 1 && (args.length >= 4 || unary)) {
          found.add(amend === "!" ? `updates or deletes from ${target} in place with !` : `amends ${target} in place`);
        }
      }
      continue;
    }
    if (k.kind === "close") {
      const kind = stack.pop();
      lambdas -= kind === "lambda" ? 1 : 0;
      if (kind === "lambda") {
        locals.pop();
      }
      continue;
    }
    if (k.kind === "name") {
      if (["select", "exec", "update", "delete"].includes(k.text)) {
        qsql = k.text;
        continue;
      }
      if (k.text === "from" && qsql !== undefined) {
        const table = symbolAt(t, i + 1);
        if ((qsql === "update" || qsql === "delete") && table !== undefined) {
          found.add(table === "`." ? "deletes from the root namespace" : `${qsql === "update" ? "updates" : "deletes from"} ${table} in place`);
        }
        qsql = undefined;
        continue;
      }
      // A writer indexed out of its namespace: `` .q[`set][`b;2] ``.
      if ((k.text === ".q" || k.text === ".Q") && next?.text === "[" && t[i + 2]?.kind === "sym") {
        const name = `${k.text}.${t[i + 2].text.slice(1)}`;
        if (WRITERS.has(unqualified(name))) {
          found.add(`calls ${name}`);
          continue;
        }
      }
      // `xasc`, `xdesc` and `xkey` on a table named by a symbol change it in
      // place: `` `a xasc `t ``, `` xasc[`a;`t] ``.
      if (["xasc", "xdesc", "xkey"].includes(unqualified(k.text))) {
        let table = symbolAt(t, i + 1);
        if (next?.text === "[" && next.kind === "open") {
          let depth = 0;
          for (let j = i + 2; j < t.length; j++) {
            if (t[j].kind === "open") depth++;
            else if (t[j].kind === "close" && --depth < 0) break;
            else if (depth === 0 && t[j].text === ";") {
              table = symbolAt(t, j + 1);
              break;
            }
          }
        }
        if (table !== undefined && table.length > 1) {
          found.add(`${unqualified(k.text) === "xkey" ? "keys" : "sorts"} ${table} in place with ${k.text}`);
        }
        continue;
      }
      if (WRITERS.has(unqualified(k.text))) {
        // `system` of a literal is read as the command it runs: `system "c"`
        // only reads, as `\c` does.
        const bracket = next?.text === "[" && next.kind === "open" ? 1 : 0;
        const literal = t[i + 1 + bracket];
        const after = t[i + 2 + bracket];
        if (
          unqualified(k.text) === "system" &&
          literal?.kind === "str" &&
          (bracket ? after?.text === "]" : after === undefined || after.kind === "close" || after.text === ";")
        ) {
          const command = new Set<string>();
          readStatement(`\\${qText(literal.text)}`, command);
          if (command.size === 0) {
            continue;
          }
        }
        found.add(`calls ${k.text}`);
        continue;
      }
      // `hopen` of a file handle creates the file, and writing through the
      // handle it returns appends to it; of a `host:port` it only connects.
      if (unqualified(k.text) === "hopen") {
        let j = i + 1;
        while (t[j] !== undefined && (t[j].text === "(" || t[j].text === "[")) {
          j++;
        }
        // The handle as written, made with `hsym`, cast from a string, or a
        // string: `` hopen hsym `f ``, `` hopen `$":f" ``, `hopen ":f"`.
        const hsym = t[j]?.text === "hsym" ? 1 : 0;
        const at = t[j + hsym];
        const text =
          at?.kind === "sym" && at.text !== "`"
            ? at.text.slice(1)
            : castHandle(t, j + hsym)
              ? qText(t[j + hsym + 2].text)
              : at?.kind === "str" && !hsym
                ? qText(at.text)
                : undefined;
        const handle = text === undefined ? undefined : text.startsWith(":") ? `\`${text}` : hsym ? `\`:${text}` : undefined;
        if (handle !== undefined && isFileHandle(handle)) {
          found.add(`opens the file ${handle} with ${k.text}`);
        }
        continue;
      }
      if (["value", "get", "eval"].includes(unqualified(k.text))) {
        // `(value)"a:1"` applies it as `value "a:1"` does.
        const wrapped = t[i - 1]?.text === "(" && next?.text === ")";
        // Given to a trap, `@[value;"a:1";h]`, `.Q.trp[value;..;h]`, it is
        // applied to the argument after it.
        const trapped = t[i - 1]?.text === "[" && t[i - 1]?.kind === "open" && next?.text === ";";
        const what = evaluated(t, i + (wrapped || trapped ? 2 : 1), unqualified(k.text) !== "eval");
        if (what !== undefined) {
          found.add(`evaluates ${what.reason} with ${k.text}`);
          i = what.at;
          continue;
        }
      }
      // A TorQ gateway runs the strings it is given on its servers (#909):
      // what they do is read as if they were sent directly.
      // Its arguments are in brackets, or what follows it to the end of the
      // expression: `` .gw.syncexec . ("a:1";`rdb) ``.
      if (GATEWAY_EXEC.test(k.text)) {
        const bracket = next?.text === "[";
        let depth = 0;
        for (let j = i + 1; j < t.length; j++) {
          if (t[j].kind === "open") depth++;
          else if (t[j].kind === "close" && ((--depth === 0 && bracket) || depth < 0)) break;
          else if (!bracket && depth === 0 && t[j].text === ";") break;
          else if (t[j].kind === "str") {
            for (const reason of writes(qText(t[j].text))) {
              found.add(`${reason} through ${k.text}`);
            }
          }
        }
        continue;
      }
      // An assignment: the name, an index, an operator, then `:`.
      let j = i + 1;
      const indexed = t[j]?.text === "[" && t[j]?.kind === "open";
      if (indexed) {
        let depth = 0;
        for (; j < t.length; j++) {
          if (t[j].kind === "open") depth++;
          else if (t[j].kind === "close" && --depth === 0) break;
        }
        j++;
      }
      const compound = t[j]?.kind === "op" && OPERATORS.has(t[j].text) && t[j + 1]?.text === ":" && touching(t[j], t[j + 1]);
      if (compound) {
        j++;
      }
      if (t[j]?.text !== ":" || t[j]?.kind !== "op") {
        continue;
      }
      const global = t[j + 1]?.text === ":" && touching(t[j], t[j + 1]);
      // In a table literal only the name that starts an item is a column:
      // `([] c:(g:5)+1 2)` and `([] d:g:3)` assign `g`.
      const top = stack[stack.length - 1];
      const column = qsql !== undefined || ((top === "table" || top === "key") && ["[", "]", ";"].includes(t[i - 1]?.text ?? ""));
      if (column && !global) {
        continue;
      }
      // In a lambda, an indexed or compound assignment to a name that is not
      // one of its locals changes the global: `{a+:1}`, `{t[0]:5}`.
      const outer = (indexed || compound) && !(locals[locals.length - 1]?.has(k.text) ?? false);
      if (lambdas === 0 || global || k.text.includes(".") || outer) {
        found.add(`assigns ${k.text}`);
      }
      continue;
    }
    // A writer named by its symbol is the function itself: `` `.q.set . (`a;1) ``,
    // `` (get `.q.set)[`a;1] ``, `` `.q.system "x" ``.
    if (k.kind === "sym" && k.text.startsWith("`.") && WRITERS.has(unqualified(k.text.slice(1)))) {
      found.add(`calls ${k.text.slice(1)}`);
      continue;
    }
    // The amend or `!` passed as a value and applied to a list headed by a
    // symbol: `` .[@;(`.;`a;:;1)] ``, `` (@) . (`.;`a;:;1) ``, `` .[!;(`t;..)] ``.
    if (k.kind === "op" && ["@", ".", "!"].includes(k.text) && t[i - 1]?.kind === "open" && (next?.text === ";" || next?.text === ")")) {
      let j = i + 1;
      while (t[j] !== undefined && (t[j].text === ")" || t[j].text === ";" || (t[j].kind === "op" && (t[j].text === "." || t[j].text === "@")))) {
        j++;
      }
      const target = t[j]?.text === "(" ? symbolAt(t, j + 1) : undefined;
      if (target !== undefined && target.length > 1 && items(t, j).length >= 4) {
        found.add(k.text === "!" ? `updates or deletes from ${target} in place with !` : `amends ${target} in place`);
        continue;
      }
    }
    // A symbol atom left of `?` extends the enumeration it names, and the
    // sym file when it is a handle: `` `sym?`x ``. A list, `` `a`b?`b ``,
    // only finds.
    if (k.kind === "sym" && k.text.length > 1 && next?.kind === "op" && next.text === "?" && t[i - 1]?.kind !== "sym") {
      found.add(`extends the enumeration ${k.text} with ?`);
      continue;
    }
    // Where the `!` of an internal function `-N!` is, spaced or with the
    // number in parentheses: `-19 !x`, `(-19)!x`. Not after a number, where
    // it ends a list: `1 -19!x`.
    const bang =
      k.kind !== "num" || !k.text.startsWith("-") || t[i - 1]?.kind === "num"
        ? -1
        : next?.text === "!"
          ? i + 1
          : t[i - 1]?.text === "(" && next?.text === ")" && t[i + 2]?.text === "!"
            ? i + 2
            : -1;
    // `-6!` is `eval`.
    if (bang > 0 && k.text === "-6") {
      const what = evaluated(t, bang + 1, false);
      if (what !== undefined) {
        found.add(`evaluates ${what.reason} with -6!`);
        i = what.at;
        continue;
      }
    }
    // Handle 0 is the process itself: `0"a:1"`, `(0)"a:1"`, `neg[0]"a:1"`
    // and `-0"a:1"` evaluate the string there.
    if (k.kind === "num" && /^-?0[ihj]?$/.test(k.text) && t[i - 1]?.kind !== "num") {
      const wrapped =
        (t[i - 1]?.text === "(" && next?.text === ")") || (t[i - 2]?.text === "neg" && t[i - 1]?.text === "[" && next?.text === "]");
      if ((wrapped ? t[i + 2] : next)?.kind === "str") {
        found.add("evaluates a string on handle 0");
        continue;
      }
    }
    // `-11!` replays a log; `-11!(-1;..)` and `(-2;..)` only count and check it.
    if (bang > 0 && k.text === "-11" && !(t[bang + 1]?.text === "(" && /^-[12]$/.test(t[bang + 2]?.text ?? ""))) {
      found.add("replays a log with -11!");
      continue;
    }
    // `-19!` compresses a file into another one.
    if (bang > 0 && k.text === "-19") {
      found.add("writes a compressed file with -19!");
      continue;
    }
    if (k.kind === "num" && (k.text === "0" || k.text === "1" || k.text === "2") && next?.text === ":" && touching(k, next)) {
      if (k.text === "2") {
        found.add("loads a shared object with 2:");
      } else if (t[i - 1]?.kind === "sym" && t[i - 1].text.startsWith("`:") && t[i - 2]?.text !== "hsym") {
        found.add(`writes the file ${t[i - 1].text} with ${k.text}:`);
      } else if (computedHandle(t, i - 1)) {
        found.add(`writes a file with ${k.text}:`);
      } else {
        // Applied rather than infix: `` 0:[`:f;x] ``, `` (0:)[`:f;x] ``,
        // `` .[0:;(`:f;x)] ``; its first argument is the handle.
        let j = i + 2;
        while (t[j]?.text === ")") j++;
        if (t[j]?.text === ";") j++;
        const first = t[j]?.kind === "open" && t[j].text !== "{" ? j + 1 : -1;
        const handle = first < 0 ? undefined : t[first]?.kind === "sym" ? t[first].text : t[first]?.text === "hsym" && t[first + 1]?.kind === "sym" ? `\`:${t[first + 1].text.slice(1)}` : undefined;
        if (handle !== undefined && isFileHandle(handle)) {
          found.add(`writes the file ${handle} with ${k.text}:`);
        }
      }
    }
  }
}

/// What `code` does that the guard asks about, each said once, in the
/// order found: `assigns trade`, `runs the system command \l`. Empty when
/// it only reads, as far as its text shows.
export function writes(code: string): string[] {
  const found = new Set<string>();
  for (const statement of statements(code)) {
    readStatement(statement, found);
  }
  return [...found];
}

/// What the guard holds `code` to on `targets`: the guarded ones, each with
/// the tags it is guarded by, and what the code does. Undefined when it
/// may be sent unasked.
export function guardCheck(code: string, targets: Pick<Process, "label" | "tags">[], settings: GuardSettings): { guarded: { label: string; tags: string[] }[]; reasons: string[] } | undefined {
  const guarded = targets.map((p) => ({ label: p.label, tags: guardedBy(p, settings) })).filter((g) => g.tags.length > 0);
  if (guarded.length === 0) {
    return undefined;
  }
  const reasons = writes(code);
  return reasons.length === 0 ? undefined : { guarded, reasons };
}

/// The most reasons, and processes, a question lists.
const LISTED = 5;

function list(items: string[]): string {
  const shown = items.slice(0, LISTED);
  const more = items.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

/// What the user is asked, as a modal's message and detail.
export function guardQuestion(check: NonNullable<ReturnType<typeof guardCheck>>): { message: string; detail: string } {
  const { guarded, reasons } = check;
  const where = guarded.length === 1 ? guarded[0].label : `${guarded.length} read-only processes`;
  const tags = [...new Set(guarded.flatMap((g) => g.tags))].join(", ");
  return {
    message: `This code would change ${where}. Run it anyway?`,
    detail:
      `${guarded.length === 1 ? `${guarded[0].label} is` : `${list(guarded.map((g) => g.label))} are`} tagged ${tags}, which ` +
      `q-lint.processes.readOnlyGuard.tags guards. The code ${list(reasons)}.`,
  };
}

/// Why a caller that cannot ask - an agent - is refused.
export function guardRefusal(check: NonNullable<ReturnType<typeof guardCheck>>): string {
  const { guarded, reasons } = check;
  return (
    `Nothing was run: ${list(guarded.map((g) => g.label))} ${guarded.length === 1 ? "is" : "are"} read-only guarded ` +
    `(tagged ${[...new Set(guarded.flatMap((g) => g.tags))].join(", ")}; q-lint.processes.readOnlyGuard.tags), and the query ${list(reasons)}. ` +
    "Send only code that reads, or ask the user to run it themselves."
  );
}
