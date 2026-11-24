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
//   `(a;b):x` assigns each name, by the same rules, as do `(a):x` and
//   `((a;b);c):x` (#1772);
// - `update` or `delete` from a table named by a symbol (`` from `t ``,
//   `` from (`t) ``), which changes it in place;
// - `set`, `upsert`, `insert`, `hdel`, `exit`, `hclose`, `system`,
//   `setenv`, `save`, `rsave`, `dsave`, `load`, `rload`, `.Q.dpft`,
//   `.Q.dpfts`, `.Q.dpt`, `.Q.dpts`, `.Q.hdpf`, `.Q.en`, `.Q.ens`,
//   `.Q.enx`, `.Q.enxs`, `.Q.chk`, `.Q.dsftg`, `.Q.view`, `.Q.l`, `.Q.lo`,
//   `.Q.li`, `.Q.bv`, `.Q.L`, `.Q.Xf` (which creates a file), `.Q.opt` (which
//   sets `.Q.x`), KDB-X's `use` (which runs a module) and `.h.ht` (which
//   writes HTML files) (#1775), and `0:` or `1:` to a
//   file handle (`` `:f 0: ``, `hsym[`f] 0:`, `(hsym `f) 1:`,
//   `` (`$":f") 0: ``, `` 0:[`:f;x] ``, `` .[0:;(`:f;x)] ``) - or to
//   anything else but a parse or prepare format (`"," 0: t`,
//   `("SJ";",") 0: f`): `1:` takes a plain symbol for a file, and a name
//   may hold a handle (#2032) - and `2:`,
//   each also by its `.q.` name (`.q.set`), by its symbol
//   (`` `.q.set . (`a;1) ``), one cast from a string too (`` (`$".q.set") ``,
//   #2037), and picked from `.q` by any index
//   (`` .q[`set] ``, `` (get`.q)`set ``, #1765) - as are `value`,
//   `get`, `eval`, `reval`, `hopen`, `xasc`, `xdesc` and `xkey`, whose
//   arguments are then not read (#1764) - `system` of a string literal
//   is read as that command, so `system "c"` only reads; `hopen` of a file handle
//   (`` hopen `:f ``, `` hopen hsym `f ``, `` hopen `$":f" ``, `hopen ":f"`),
//   which creates the file to write through, also applied some other way
//   (`` hopen@`:f ``, `` @[hopen;`:f;h] ``, `` hopen -1!`f ``, #1769) - of a
//   process (`` `:host:5000 ``, a port) it only connects, and what is sent
//   over that handle is not read;
// - `xasc`, `xdesc` or `xkey` on a table named by a symbol
//   (`` `a xasc `t ``), which sorts or keys it in place, also applied some
//   other way with a symbol for the columns and one for the table in its
//   expression (`` .[xkey;(`a;`t)] ``, `` xkey/[`a;`t] ``, #1770);
// - `?` with a symbol atom on its left (`` `sym?`x ``, `` (`sym)?`x ``,
//   `` ?[`sym;`x] ``), which extends that enumeration, and the sym file
//   when the symbol is a handle; also passed as a value, in parentheses,
//   through an adverb or to `.` or `@` (`` (?)[`sym;`x] ``, `` ?/[`sym;`x] ``,
//   `` .[?;(`sym;`x)] ``), read as the call it makes (#2036);
// - a string or a list sent to handle 0 (`0"a:1"`, `neg[0]"a:1"`,
//   `0(@;`b;0;:;9)`), which the process evaluates itself as `value` would;
// - `-11!`, which replays a log through `upd`, except `-11!(-1;..)` and
//   `-11!(-2;..)`, which only count and check one; `-19!`, which
//   compresses a file into another - each also spaced or with the number
//   in parentheses (`-19 !x`, `(-19)!x`);
// - `@[` or `.[` on a variable named by a symbol, alone or in
//   parentheses (`` .[(`t);..] ``), with three arguments or four: an
//   amend in place - on a symbol it is never a trap, `.[`f;args;h]`
//   amends `f` or fails (#1763); `![` with four likewise, a functional
//   update or delete. Also through an adverb or applied first in a
//   composition (`` @/[`.;`a;:;9] ``, `` '[::;@][..] ``), with the target left
//   out and given after (`` @[;`a;:;1] `. ``), and the amend or `!`
//   passed as a value (`` .[@;(`.;`a;:;1)] ``, `` (@) . (`.;..) ``);
// - `value`, `get`, `eval`, `reval`, `-6!` or `-24!`, or in k code a monadic `.`
//   (`` k)."a:1" ``), applied to a string that changes the process by these
//   rules - `value "count t"` reads (#1776) - or one built or passed through
//   another function (`value "a",":1"`), to `parse` or
//   `-5!`, or to a tree headed by `:`, `::` or `+:` (`eval(:;`t;())`), by
//   an amend `@` or `.` of four items or more on a variable by name
//   (`` value(@;`.;`a;:;1) ``, `` eval(@;enlist`.;enlist`a;:;1) ``), by
//   `!` on a table by name (`` eval(!;enlist`t;..) ``, `` value(!;`t;..) ``)
//   or by the symbol of
//   a writer above (`` value(`.q.set;`a;1) ``), or by anything that, called
//   on the rest, changes the process (`value(hopen;`:f)`,
//   `value(value;"a:1")`, #1767), also through `[`,
//   `each`, `'`, `@`, `.` or `enlist`, in parentheses (`(value)"a:1"`)
//   and through a trap (`@[value;"a:1";h]`), and by their `.q.` names;
//   passed as a value, through an adverb or a composition (`value/["a:1"]`,
//   `'[value;::]"a:1"`), each string in the expression around it (#1766);
// - a system command (`\l`, `\cd x`, `\\`), also after a language prefix
//   or several, `k)\l f.q`, `q)k)\cd x` (#2034), except one that only reads a
//   setting (`\c`, `\d`, `\P`, `\_`, `\r`, `\E` without an argument, and
//   `\w 0` or `\w 1`) and `\t` or `\ts`, whose
//   expression is read by these rules - but `\t 500`, a whole number with
//   no `:N`, sets the timer;
// - any of these in a lambda applied where it is written, read with its
//   arguments in place of its parameters (`` {.[x;();:;1]}`a ``,
//   `{value x} each enlist "a:1"`), and where an argument is a name or not
//   written, with a symbol it could hold (`` {.[x;();:;1]} v ``, #2035);
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

type Address = Pick<Process, "host" | "port" | "user" | "tls" | "tags">;

/// The tags an open connection goes by when its saved process is changed to
/// `saved`: the new ones, and while the connection is still to another
/// address - host, port, user or TLS changed - its old ones too, so one to
/// a guarded process stays guarded until it is connected again (#1443).
export function openTags(open: Address, saved: Address): string[] {
  const moved = saved.host !== open.host || saved.port !== open.port || saved.user !== open.user || (saved.tls === true) !== (open.tls === true);
  return moved ? [...new Set([...open.tags, ...saved.tags])] : saved.tags;
}

type Kind = "name" | "sym" | "str" | "num" | "op" | "open" | "close" | "space";
interface Token {
  kind: Kind;
  text: string;
  /// Where it starts in the statement.
  pos: number;
}

const NAME_START = /[A-Za-z.]/;
const NAME = /[A-Za-z0-9_.]/;
/// The characters that make a compound assignment with `:` after them.
const OPERATORS = new Set([..."+-*%&|^=<>$,#_~!?@."]);
const WRITERS = new Set([
  "set", "upsert", "insert", "hdel", "exit", "hclose", "system", "save", "rsave", "dsave", "load", "rload", "setenv",
  ".Q.dpft", ".Q.dpfts", ".Q.dpt", ".Q.dpts", ".Q.hdpf", ".Q.en", ".Q.ens", ".Q.enx", ".Q.enxs", ".Q.chk", ".Q.dsftg",
  ".Q.view", ".Q.l", ".Q.lo", ".Q.li", ".Q.bv", ".Q.opt", ".Q.Xf", ".Q.L", "use", ".h.ht",
]);
/// What evaluates a string or a parse tree it is given.
const EVALUATORS = new Set(["value", "get", "eval", "reval"]);
/// What changes the process when it is called on the right arguments: the
/// writers, the evaluators, `hopen` and what sorts or keys a table. Taken
/// out of `.q` or named by its symbol, it is the function itself, whose
/// arguments are not read: `` .q[`value] ``, `` `.q.xkey `` (#1764).
const CALLED = new Set([...WRITERS, ...EVALUATORS, "hopen", "xasc", "xdesc", "xkey"]);
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
      const text = code.slice(i, j + 1);
      // A symbol cast from a string, `` `$".q.set" ``, is that symbol (#2037).
      const tail = out.filter((k, n) => n >= out.length - 4 && k.kind !== "space");
      const cast = tail.length >= 2 && tail[tail.length - 1].text === "$" && tail[tail.length - 2].kind === "sym" && tail[tail.length - 2].text === "`";
      if (cast) {
        const start = out.lastIndexOf(tail[tail.length - 2]);
        out.splice(start, out.length - start, { kind: "sym", text: `\`${qText(text)}`, pos: tail[tail.length - 2].pos });
      } else {
        out.push({ kind: "str", text, pos: i });
      }
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
      out.push({ kind: "space", text: code.slice(i, j), pos: i });
      i = j;
    } else if (c === "`") {
      let j = i + 1;
      const path = code[j] === ":";
      while (j < code.length && (/[A-Za-z0-9_.:]/.test(code[j]) || (path && code[j] === "/"))) {
        j++;
      }
      out.push({ kind: "sym", text: code.slice(i, j), pos: i });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(code[i + 1] ?? "") && (out.length === 0 || out[out.length - 1].kind !== "name"))) {
      let j = i + 1;
      while (j < code.length && /[0-9A-Za-z.]/.test(code[j])) {
        j++;
      }
      out.push({ kind: "num", text: code.slice(i, j), pos: i });
      i = j;
    } else if (NAME_START.test(c) && !(c === "." && !NAME_START.test(code[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < code.length && NAME.test(code[j])) {
        j++;
      }
      out.push({ kind: "name", text: code.slice(i, j), pos: i });
      i = j;
    } else if ("([{".includes(c)) {
      out.push({ kind: "open", text: c, pos: i });
      i++;
    } else if (")]}".includes(c)) {
      out.push({ kind: "close", text: c, pos: i });
      i++;
    } else {
      out.push({ kind: "op", text: c, pos: i });
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

/// Whether `inside` builds a file handle: with `hsym`, `` ` sv `` or
/// `.Q.dd`, or holds a file's `` `:f ``: `` ` sv `:d`f ``, `` .Q.dd[`:d;`f] ``.
function buildsHandle(inside: Token[]): boolean {
  return inside.some(
    (k, n) =>
      (k.kind === "name" && (k.text === "hsym" || k.text === ".Q.dd")) ||
      (k.text === "`" && inside[n + 1]?.text === "sv") ||
      (k.kind === "sym" && k.text.length > 2 && isFileHandle(k.text)),
  );
}

/// Whether the left argument of `0:` or `1:`, ending at `t[end]`, makes a
/// file handle: `hsym `f`, `hsym[`f]`, `(hsym `f)`, `` (`:f) ``,
/// `` (` sv `:d`f) `` or `` .Q.dd[`:d;`f] ``. A parse format, `("SJ";",")`,
/// does not.
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
  return t[open - 1]?.text === "hsym" || t[open - 1]?.text === ".Q.dd" || (t[open].text === "(" && (buildsHandle(inside) || (inside.length === 1 && inside[0].kind === "sym" && inside[0].text.startsWith("`:")) || castHandle(inside, 0)));
}

/// Whether a file's handle is made between `t[from]` and `t[to]`: written,
/// `` `:f ``, made with `hsym` or `-1!`, `` hsym`f ``, `` -1!`f ``, cast,
/// `` `$":f" ``, or a string, `":f"`. A process's, `` `:host:5000 ``, is not.
function fileIn(t: Token[], from: number, to: number): boolean {
  for (let p = from; p < to; p++) {
    const k = t[p];
    const made =
      (k.kind === "name" && unqualified(k.text) === "hsym" && t[p + 1]?.kind === "sym") ||
      (k.text === "-1" && t[p + 1]?.text === "!" && t[p + 2]?.kind === "sym");
    const sym = made ? t[p + (k.text === "-1" ? 2 : 1)].text : undefined;
    if (
      (k.kind === "sym" && k.text.length > 2 && isFileHandle(k.text)) ||
      (sym !== undefined && sym.length > 1 && isFileHandle(sym.startsWith("`:") ? sym : `\`:${sym.slice(1)}`)) ||
      (castHandle(t, p) && isFileHandle(`\`${qText(t[p + 2].text)}`)) ||
      (k.kind === "str" && k.text.startsWith('":') && isFileHandle(`\`${qText(k.text)}`))
    ) {
      return true;
    }
  }
  return false;
}

/// The left argument of the `0:` or `1:` at `t[at]`, `[start, end)`: a
/// string, a symbol, a name, a number or what is in the parentheses before
/// it, `[at, at)` for an index, `x[0] 0: ..`, which cannot be read; undefined
/// when nothing is left of it, `0:[..]`, `.[0:;..]`.
function leftArgument(t: Token[], at: number): [number, number] | undefined {
  const k = t[at - 1];
  if (k === undefined || k.kind === "op" || k.kind === "open" || k.kind === "space") {
    return undefined;
  }
  if (k.kind !== "close") {
    return [at - 1, at];
  }
  if (k.text !== ")") {
    return [at, at];
  }
  let open = at - 1;
  for (let depth = 0; open >= 0; open--) {
    if (t[open].kind === "close") depth++;
    else if (t[open].kind === "open" && --depth === 0) break;
  }
  return open < 0 ? [at, at] : [open, at];
}

/// Whether `t[from]` to `t[to]` is a parse or prepare format, which `0:` and
/// `1:` read with rather than write to: a string, `","`, `4#"i"`, or a list
/// whose first item is one, `("SJ";enlist ",")` - a string and no symbol or
/// name but `enlist`. Anything else may be a file's handle (#2032).
function formatIn(t: Token[], from: number, to: number): boolean {
  while (t[from]?.text === "(" && t[to - 1]?.text === ")" && items(t, from).length === 1 && items(t, from)[0][1] === to - 1) {
    from++;
    to--;
  }
  const [s, e] = t[from]?.text === "(" && t[from].kind === "open" && items(t, from).length > 1 && items(t, from).at(-1)?.[1] === to - 1 ? items(t, from)[0] : [from, to];
  const part = t.slice(s, e);
  return part.some((k) => k.kind === "str") && part.every((k) => k.kind !== "sym" && (k.kind !== "name" || k.text === "enlist"));
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

/// Where the list of names that opens at `t[open]` ends - past its `)` - when
/// it holds only names and lists of them, `((a;b);c)`, with each name added
/// to `names`; -1 otherwise.
function destructured(t: Token[], open: number, names: string[]): number {
  let j = open + 1;
  for (;;) {
    if (t[j]?.kind === "name") {
      names.push(t[j].text);
      j++;
    } else if (t[j]?.text === "(" && t[j].kind === "open") {
      j = destructured(t, j, names);
      if (j < 0) return -1;
    } else {
      return -1;
    }
    if (t[j]?.text === ")") return j + 1;
    if (t[j]?.text !== ";") return -1;
    j++;
  }
}

/// The amend, `@`, `.` or `!`, that the bracket opening at `t[open]` applies,
/// or "": right before it, in parentheses, `` (@)[`.;`a;:;1] `` (#1445), as
/// many pairs as are written (#1730), through an adverb, `` @/[`.;`a;:;9] ``,
/// or applied first in a composition, `` '[::;@][`.;`a;:;9] `` (#1771).
function amendBefore(t: Token[], open: number): string {
  let p = open - 1;
  let parens = 0;
  for (;;) {
    if (t[p]?.kind === "close" && t[p].text === ")") {
      parens++;
      p--;
    } else if (t[p]?.kind === "op" && ["/", "\\", "'"].includes(t[p].text) && t[p - 1]?.kind === "op") {
      p--;
    } else {
      break;
    }
  }
  let op: Token | undefined = t[p];
  if (op?.kind === "close" && op.text === "]") {
    // A composition, `'[f;g]`: the last function is applied first.
    let o = p;
    for (let depth = 0; o >= 0; o--) {
      if (t[o].kind === "close") depth++;
      else if (t[o].kind === "open" && --depth === 0) break;
    }
    const all = o > 0 && t[o - 1].kind === "op" && t[o - 1].text === "'" ? items(t, o) : [];
    const last = all.length > 1 ? t.slice(all[all.length - 1][0], all[all.length - 1][1]).filter((k) => k.text !== "(" && k.text !== ")") : [];
    op = last.length === 1 ? last[0] : undefined;
    p = o - 1;
  }
  const wrapped = Array.from({ length: parens }, (_, n) => t[p - 1 - n]).every((k) => k?.text === "(" && k.kind === "open");
  return op?.kind === "op" && ["@", ".", "!"].includes(op.text) && wrapped ? op.text : "";
}

/// The fewest arguments with which `@` and `.` amend a variable by name -
/// three, with a unary, `` @[`t;`c;neg] `` - and `!` updates or deletes.
function minimum(amend: string): number {
  return amend === "!" ? 4 : 3;
}

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
/// plain `:`, outside the lambdas nested in it. A column, `select a:b from t`
/// or `([] a:1 2)`, is not one, as `readStatement` has it (#1444).
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
  // What each bracket open in the body is, and the qsql keywords open in it.
  const kinds: ("table" | "key" | "other")[] = [];
  let qsql = 0;
  for (; i < t.length; i++) {
    const k = t[i];
    if (k.kind === "open") {
      depth++;
      nested += nested > 0 || k.text === "{" ? 1 : 0;
      kinds.push(k.text === "(" && t[i + 1]?.text === "[" ? "table" : k.text === "[" && kinds[kinds.length - 1] === "table" && t[i - 1]?.text === "(" ? "key" : "other");
    } else if (k.kind === "close") {
      if (depth-- === 0) break;
      nested -= nested > 0 ? 1 : 0;
      kinds.pop();
    } else if (nested === 0 && k.kind === "name" && ["select", "exec", "update", "delete"].includes(k.text)) {
      qsql++;
    } else if (nested === 0 && k.kind === "name" && k.text === "from" && qsql > 0) {
      qsql--;
    } else if (nested === 0 && k.kind === "name" && t[i + 1]?.kind === "op" && t[i + 1].text === ":" && !(t[i + 2]?.text === ":" && touching(t[i + 1], t[i + 2]))) {
      const top = kinds[kinds.length - 1];
      if (qsql === 0 && !((top === "table" || top === "key") && ["[", "]", ";"].includes(t[i - 1]?.text ?? ""))) {
        out.add(k.text);
      }
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
  // The lists it passes into, `((value);"a:1")`, for `called`.
  const lists: number[] = [];
  while (
    t[j] !== undefined &&
    ((t[j].kind === "open" && t[j].text !== "{") ||
      (t[j].kind === "name" && ["each", "peach", "enlist"].includes(t[j].text)) ||
      (t[j].kind === "op" &&
        ["'", "@", "."].includes(t[j].text) &&
        !(t[j - 1]?.text === "(" && (t[j + 1]?.text === ";" || t[j + 1]?.text === "[" || (t[j - 2]?.text === "(" && t[j + 1]?.text === ")" && t[j + 2]?.text === ";")))))
  ) {
    if (t[j].text === "(") lists.push(j);
    j++;
  }
  const k = t[j];
  // The amend at the head in parentheses of its own, `` value((@);`a;();:;1) ``
  // (#1727): what follows it is read past the `)`.
  const wrap = k?.kind === "op" && t[j + 1]?.text === ")" && t[j - 2]?.text === "(" ? 1 : 0;
  const head = t[j - 1 - wrap]?.text === "(" && t[j - 1 - wrap]?.kind === "open";
  // The item after `t[at]`'s `;`, the variable an amend names: as it is for
  // `value`, `enlist`ed for `eval`.
  const named = (at: number): Token | undefined => (t[at]?.text !== ";" ? undefined : byValue ? t[at + 1] : t[at + 1]?.text === "enlist" ? t[at + 2] : undefined);
  // An amend projected on all but its target, at the head and applied to the
  // variable after it: `` value(@[;`a;:;2];`.) `` (#1727).
  const projection = head && (k?.text === "@" || k?.text === ".") && t[j + 1]?.text === "[" ? items(t, j + 1) : [];
  const projected =
    projection.length > 0 && projection.length >= minimum(k?.text ?? "") && projection[0][0] === projection[0][1] && named(projection[projection.length - 1][1] + 1)?.kind === "sym" && (named(projection[projection.length - 1][1] + 1)?.text.length ?? 0) > 1;
  // (`(::)` alone is the identity, not an assignment.)
  const reason = head && k?.kind === "op" && (k.text === ":" || (OPERATORS.has(k.text) && t[j + 1]?.text === ":")) && items(t, j - 1).length > 1
    ? "an assignment"
    : head && k?.text === "!" && t[j + 1]?.text === ";" && (byValue ? t[j + 2] : t[j + 2]?.text === "enlist" ? t[j + 3] : undefined)?.kind === "sym"
      ? "a functional update or delete"
      : head && k?.kind === "sym" && WRITERS.has(unqualified(k.text.slice(1)))
        ? `a call of ${k.text.slice(1)}`
        : // An amend on a variable by name: `` value(@;`.;`a;:;1) ``,
          // `` eval(@;enlist`.;enlist`a;:;1) `` (#1446).
          (head && (k?.text === "@" || k?.text === ".") && named(j + 1 + wrap)?.kind === "sym" && (named(j + 1 + wrap)?.text.length ?? 0) > 1 && items(t, j - 1 - wrap).length > minimum(k?.text ?? "")) || projected
          ? "an amend"
          : called(t, lists, byValue);
  return reason === undefined ? undefined : { reason, at: j };
}

/// The text of `t[from]` to `t[to]`, spaced as written.
function joined(t: Token[], from: number, to: number): string {
  return t
    .slice(from, to)
    .map((k, n, all) => (n > 0 && all[n - 1].pos + all[n - 1].text.length < k.pos ? ` ${k.text}` : k.text))
    .join("");
}

/// What a list an evaluator runs, opening at one of `lists`, does as the
/// call it is: `(f;x;y)` is `f[x;y]`, so `value(hopen;`:f)` opens the file
/// as `hopen[`:f]` does, and `value(value;"a:1")` evaluates (#1767). For
/// `eval` an argument `` `x `` is the variable and `` enlist`x `` the symbol.
function called(t: Token[], lists: number[], byValue: boolean): string | undefined {
  for (const open of [...lists].reverse()) {
    const all = items(t, open);
    const [hs, he] = all[0];
    if (all.length < 2 || he - hs < 1 || !["name", "sym", "op", "open"].includes(t[hs].kind) || t[hs].text === "{") {
      continue;
    }
    const head = he - hs === 1 && t[hs].kind === "sym" ? t[hs].text.slice(1) : joined(t, hs, he);
    const args = all.slice(1).map(([s, e]) =>
      byValue || e - s > 2
        ? joined(t, s, e)
        : e - s === 1 && t[s].kind === "sym"
          ? t[s].text.slice(1)
          : e - s === 2 && t[s].text === "enlist" && t[s + 1].kind === "sym"
            ? t[s + 1].text
            : joined(t, s, e),
    );
    return writes(`${head}[${args.join(";")}]`).length > 0 ? `a call of ${head}` : undefined;
  }
  return undefined;
}

/// The names and operators an evaluator's argument may pass through on its
/// way to a string and still be that string: `value each enlist "x"`,
/// `` @[value;"x";::] ``, `eval parse "x"`.
const PASSING = new Set(["each", "peach", "enlist", "parse", ...EVALUATORS]);
const PASSING_OPS = new Set([..."@.'/\\:;"]);

/// Where the argument of what ends at `t[last]` ends: at the first `;` or
/// close outside the brackets it opens.
function argumentEnd(t: Token[], last: number): number {
  let depth = 0;
  for (let p = last + 1; p < t.length; p++) {
    if (t[p].kind === "open") depth++;
    else if (t[p].kind === "close" && depth-- === 0) return p;
    else if (depth === 0 && t[p].text === ";") return p;
  }
  return t.length;
}

/// How many brackets are open around `t[i]`, back to its lambda.
function around(t: Token[], i: number): number {
  let depth = 0;
  for (let p = i - 1, inner = 0; p >= 0; p--) {
    if (t[p].kind === "close") inner++;
    else if (t[p].kind === "open" && inner > 0) inner--;
    else if (t[p].kind === "open" && t[p].text === "{") break;
    else if (t[p].kind === "open") depth++;
  }
  return depth;
}

/// Where the expression `t[i]` is in starts: after the `;` before it outside
/// every bracket around it, or the start of its lambda or statement.
function expressionStart(t: Token[], i: number): number {
  let depth = around(t, i);
  for (let p = i - 1; p >= 0; p--) {
    if (t[p].kind === "close") depth++;
    else if (t[p].kind === "open" && depth-- === 0) return p + 1;
    else if (depth === 0 && t[p].text === ";") return p + 1;
  }
  return 0;
}

/// Where the expression `t[i]` is in ends: at the next `;` outside every
/// bracket around it, or the end of the lambda or statement it is in.
function expressionEnd(t: Token[], i: number): number {
  let depth = around(t, i);
  for (let p = i + 1; p < t.length; p++) {
    if (t[p].kind === "open") depth++;
    else if (t[p].kind === "close" && depth-- === 0) return p;
    else if (depth === 0 && t[p].text === ";") return p;
  }
  return t.length;
}

/// What the strings an evaluator ending at `t[last]` is applied to run, up
/// to `t[end]`: each is read as the code it is (#1776), so `value "count t"`
/// reads, as a gateway's string does. One that is built, `value "a",":1"`,
/// or reaches it through another function, `value raze("a";":1")`, is
/// taken for a change; so is `parse` of what is not a string, and in k
/// code, `k)."x"`, any string, which is k and not read here.
function strings(t: Token[], last: number, end: number, kCode: boolean): string | undefined {
  let passing = true;
  let parsed = false;
  let seen = false;
  let lambda = 0;
  for (let p = last + 1; p < end; p++) {
    const k = t[p];
    if (k.kind === "open" && k.text === "{") lambda++;
    else if (k.kind === "close" && k.text === "}") lambda--;
    if (lambda > 0 || k.text === "}") continue;
    if (k.kind === "name") {
      parsed ||= k.text === "parse";
      passing &&= PASSING.has(unqualified(k.text));
    } else if (k.kind === "num" && k.text === "-5" && t[p + 1]?.text === "!") {
      parsed = true;
      p++;
    } else if (k.kind === "op") {
      passing &&= PASSING_OPS.has(k.text);
    } else if (k.kind === "str") {
      seen = true;
      const whole = passing && (p + 1 >= end || t[p + 1].text === ";" || t[p + 1].kind === "close");
      if (!whole || kCode || writes(qText(k.text)).length > 0) {
        return parsed ? "a parse tree" : "a string";
      }
    }
  }
  return parsed && !seen ? "a parse tree" : undefined;
}

/// What an evaluator ending at `t[last]` runs that changes the process: a
/// tree `evaluated` reads, or a string `strings` does.
function evaluates(t: Token[], last: number, byValue: boolean, kCode = false, end = argumentEnd(t, last)): { reason: string; at: number } | undefined {
  const what = evaluated(t, last + 1, byValue);
  if (what !== undefined) {
    return what;
  }
  const reason = strings(t, last, end, kCode);
  return reason === undefined ? undefined : { reason, at: last };
}

/// The function of `CALLED` picked out of `root`, `.q` or `.Q`, at `t[at]`
/// by whatever names it in the expression after it - `` .q[enlist`set]0 ``,
/// `` .q`$"set" ``, `` (.q`set`get)0 ``, `` (get`.q)`set `` (#1765) - or
/// undefined: `` .q`count `` reads.
function picked(t: Token[], at: number, root: string): string | undefined {
  const end = expressionEnd(t, at);
  for (let p = at + 1; p < end; p++) {
    const name = t[p].kind === "sym" ? t[p].text.slice(1) : t[p].kind === "str" ? qText(t[p].text) : undefined;
    if (name !== undefined && CALLED.has(unqualified(`${root}.${name}`))) {
      return `${root}.${name}`;
    }
  }
  return undefined;
}

/// What a lambda's parameter is given in place of an argument that is a
/// name, or not written, which could name a global or a file:
/// `` {.[x;();:;1]} v `` amends whatever `v` names.
const WITNESSES = ["(`g)", "(`:g)"];
/// The most items of an iterated argument a lambda is read again with.
const ITEMS = 8;
/// The names after a lambda that apply it to each item of what follows.
const ITERATORS = new Set(["each", "peach", "over", "scan", "prior"]);
/// How deep `writes` is called in itself, and how many lambdas it has read
/// again with their parameters given: past `REREADS` a lambda applied to
/// what it cannot read is taken for a change rather than read again.
let nesting = 0;
let rereads = 0;
const REREADS = 2000;
/// What `writes` found in a text read again, by the text, kept from one
/// call to the next - it depends on the text alone - up to `KEPT`
/// characters of them.
const reread = new Map<string, string[]>();
const KEPT = 4_000_000;
let kept = 0;

function rereadOf(text: string): string[] {
  let found = reread.get(text);
  if (found === undefined) {
    rereads++;
    found = writes(text);
    if (kept + text.length > KEPT) {
      reread.clear();
      kept = 0;
    }
    kept += text.length;
    reread.set(text, found);
  }
  return found;
}

/// The items of the argument `t[from]` to `t[to]` a lambda is applied to
/// each of: the symbols of `` `a`b ``, the items of `(x;y)`, or none.
function itemsOf(t: Token[], from: number, to: number): string[] {
  if (to - from > 1 && t.slice(from, to).every((k) => k.kind === "sym")) {
    return t.slice(from, to).map((k) => k.text);
  }
  const all = t[from]?.text === "(" && t[from].kind === "open" ? items(t, from) : [];
  return all.length > 1 && all[all.length - 1][1] === to - 1 ? all.map(([a, b]) => joined(t, a, b)) : [];
}

/// What the lambda that opens at `t[open]`, applied where it is written,
/// changes through its parameters (#2035): read again with each argument
/// in place of its parameter, `` {.[x;();:;1]}`a `` as `` .[(`a);();:;1] ``,
/// through `each` or an adverb with each item too, and where an argument is
/// a name or not written, with a global's and a file's symbol, which it
/// could be. `all` is the statement's
/// tokens, spaces too, and `index` where each one is among them. A lambda
/// assigned, `f:{value x}`, an item of a list, or the value of the code or
/// of the lambda around it, is not applied here.
function throughParameters(t: Token[], all: Token[], index: Map<Token, number>, closes: number[], open: number, found: Set<string>): void {
  const close = closes[open];
  if (close === undefined || close < 0) {
    return;
  }
  // Its parameters, named or `x`, `y` and `z` up to the last its body uses.
  const named = t[open + 1]?.text === "[" && t[open + 1].kind === "open";
  let params: string[] = [];
  let listEnd = open;
  if (named) {
    for (listEnd = open + 2; listEnd < close && t[listEnd].text !== "]"; listEnd++) {
      if (t[listEnd].kind === "name") params.push(t[listEnd].text);
    }
  } else {
    let last = -1;
    for (let p = open + 1; p < close; p++) {
      if (t[p].kind === "open" && t[p].text === "{") p = closes[p] < 0 ? close : closes[p];
      else if (t[p].kind === "name") last = Math.max(last, ["x", "y", "z"].indexOf(t[p].text));
    }
    params = ["x", "y", "z"].slice(0, last + 1);
  }
  if (params.length === 0) {
    return;
  }
  let s = open;
  let e = close;
  while (t[s - 1]?.text === "(" && t[e + 1]?.text === ")") {
    s--;
    e++;
  }
  // Past an adverb or `each`, it is applied to each item.
  let q = e + 1;
  while (t[q]?.kind === "op" && ["'", "/", "\\", ":"].includes(t[q].text)) q++;
  if (t[q]?.kind === "name" && ITERATORS.has(t[q].text)) q++;
  const iterated = q > e + 1;
  const after = t[q];
  const before = t[s - 1];
  // Each parameter's argument as written, and the items it is applied to.
  let args: ([number, number] | undefined)[] = [];
  if (after?.kind === "open" && after.text === "[") {
    args = items(t, q).map(([a, b]) => (a === b ? undefined : [a, b]));
  } else if (after?.kind === "op" && (after.text === "@" || after.text === ".") && argumentEnd(t, q) > q + 1) {
    const arg: [number, number] = [q + 1, argumentEnd(t, q)];
    args = after.text === "@" ? [arg] : itemsOf(t, arg[0], arg[1]).length > 0 ? items(t, arg[0]).map(([a, b]): [number, number] => [a, b]) : [];
  } else if (after !== undefined && (["str", "sym", "num", "name"].includes(after.kind) || after.kind === "open")) {
    args = [[q, argumentEnd(t, q - 1)]];
  } else if (before?.kind === "open" && before.text === "[" && (t[s - 2]?.text === "." || t[s - 2]?.text === "@") && t[s - 2].kind === "op") {
    // Applied by `.[f;(x;y)]` or `@[f;x]`, a trap among them.
    const all = items(t, s - 1);
    const arg = all[1];
    if (arg !== undefined && arg[0] < arg[1]) {
      args = t[s - 2].text === "@" ? [arg] : itemsOf(t, arg[0], arg[1]).length > 0 ? items(t, arg[0]).map(([a, b]): [number, number] => [a, b]) : [];
    }
  } else if (
    !iterated &&
    (after === undefined || after.text === ";" || after.kind === "close") &&
    (before === undefined ||
      before.text === ":" ||
      before.text === "{" ||
      // The argument of a lambda before it, which reads it in its place.
      before.text === "}" ||
      // An item of a list, applied only once the list is: `value(f;x)`.
      (before.text === "(" && after?.text === ";") ||
      (before.text === ";" && (around(t, s) === 0 || after?.text === ";" || after?.text === ")")))
  ) {
    return;
  }
  if (rereads > REREADS) {
    found.add("applies a lambda that may change the process through what it is given");
    return;
  }
  // The lambda's text with `given` in place of its parameters, which it then
  // no longer takes.
  const text = (given: Map<string, string>): string => {
    const out: string[] = [];
    const from = index.get(t[open]) ?? 0;
    const to = index.get(t[close]) ?? 0;
    const list = named ? (index.get(t[listEnd]) ?? from) : from;
    const kept = `[${params.filter((p) => !given.has(p)).join(";")}]`;
    for (let p = from, nested = 0; p <= to; p++) {
      const k = all[p];
      if (p === from) {
        out.push(given.size > 0 || named ? `{${kept}` : "{");
        p = list;
        continue;
      }
      if (k.kind === "open" && k.text === "{") nested++;
      else if (k.kind === "close" && k.text === "}") nested--;
      out.push(nested === 0 && k.kind === "name" && given.has(k.text) ? (given.get(k.text) ?? k.text) : k.text);
    }
    return out.join("");
  };
  const base = rereadOf(text(new Map()));
  // Read with every argument in place, with the first item of each when it
  // is iterated, and with a symbol for each one that is a name or not
  // written: a few readings, whatever the count of parameters.
  // A name may hold a global's symbol; what a call returns is read as the
  // call, `{@[x;0;3_]} read0 f` as `@[(read0 f);0;3_]`.
  const written = params.map((_, n) => (args[n] === undefined ? undefined : `(${joined(t, args[n][0], args[n][1])})`));
  const held = params.map((_, n) => args[n] === undefined || (args[n][1] - args[n][0] === 1 && t[args[n][0]].kind === "name"));
  const readings: [Map<string, string>, boolean][] = [];
  if (written.some((w) => w !== undefined)) {
    readings.push([new Map(params.flatMap((p, n): [string, string][] => (written[n] === undefined ? [] : [[p, written[n]]]))), false]);
    // Item by item, the first few.
    const each = iterated ? params.map((_, n) => (args[n] === undefined ? [] : itemsOf(t, args[n][0], args[n][1]))) : [];
    for (let m = 0; m < Math.min(ITEMS, Math.max(0, ...each.map((i) => i.length))); m++) {
      readings.push([new Map(params.flatMap((p, n): [string, string][] => (written[n] === undefined ? [] : [[p, each[n][m] === undefined ? written[n] : `(${each[n][m]})`]]))), false]);
    }
  }
  if (held.some((h) => h)) {
    for (const witness of WITNESSES) {
      readings.push([new Map(params.flatMap((p, n): [string, string][] => (held[n] ? [[p, witness]] : written[n] === undefined ? [] : [[p, written[n]]]))), true]);
    }
  }
  for (const [given, guessed] of readings) {
    for (const reason of rereadOf(text(given))) {
      if (!base.includes(reason)) {
        found.add(guessed ? "applies a lambda that may change the process through what it is given" : reason);
      }
    }
  }
}

/// The operators that change the process given the right arguments, read
/// as a call when they are passed as a value: `?`, which extends an
/// enumeration, and the amends `@` and `.`.
const VALUES = new Set(["?", "@", "."]);

/// The items of the list `t[from]` to `t[to]` an operator is applied to by
/// `.`, `(x;y)` or `enlist x`; undefined when they are not written.
function listed(t: Token[], from: number, to: number): [number, number][] | undefined {
  if (t[from]?.text === "(" && t[from].kind === "open") {
    const all = items(t, from);
    return all[all.length - 1][1] === to - 1 ? all : undefined;
  }
  return t[from]?.text === "enlist" && to > from + 1 ? [[from + 1, to]] : undefined;
}

/// The calls the operator at `t[i]` makes when it is passed as a value
/// rather than written between its arguments: in parentheses,
/// `` (?)[`sym;`x] ``, through an adverb with nothing on its left,
/// `` ?/[`sym;`x] ``, or given to `.` or `@`, `` .[?;(`sym;`x)] `` -
/// written out, `` (`sym)?(`x) ``, for the rules to read (#2036). Through an
/// adverb, also on the first item of each argument that is a list.
function asValue(t: Token[], i: number): string[] {
  const op = t[i].text;
  let s = i;
  let e = i;
  while (t[s - 1]?.text === "(" && t[s - 1].kind === "open" && t[e + 1]?.text === ")") {
    s--;
    e++;
  }
  let q = e + 1;
  while (t[q]?.kind === "op" && ["'", "/", "\\", ":"].includes(t[q].text)) q++;
  const iterated = q > e + 1;
  const left = t[s - 1];
  let args: [number, number][] | undefined;
  if (left?.kind === "open" && left.text === "[" && t[s - 2]?.kind === "op" && (t[s - 2].text === "." || t[s - 2].text === "@") && t[e + 1]?.text === ";") {
    const arg = items(t, s - 1)[1];
    args = arg === undefined || arg[0] === arg[1] ? undefined : t[s - 2].text === "@" ? [arg] : listed(t, arg[0], arg[1]);
  } else if (s < i || (iterated && (left === undefined || left.kind === "open" || left.text === ";"))) {
    const after = t[q];
    if (after?.kind === "open" && after.text === "[") {
      args = items(t, q);
    } else if (after?.kind === "op" && (after.text === "." || after.text === "@") && argumentEnd(t, q) > q + 1) {
      args = after.text === "@" ? [[q + 1, argumentEnd(t, q)]] : listed(t, q + 1, argumentEnd(t, q));
    }
  }
  if (args === undefined || args.length === 0 || args.some(([a, b]) => a === b)) {
    return [];
  }
  const call = (texts: string[]): string => (texts.length === 2 ? `(${texts[0]})${op}(${texts[1]})` : `${op}[${texts.join(";")}]`);
  const calls = [call(args.map(([a, b]) => joined(t, a, b)))];
  if (iterated) {
    calls.push(call(args.map(([a, b]) => itemsOf(t, a, b)[0] ?? joined(t, a, b))));
  }
  return calls;
}

/// What one statement does that the guard asks about, added to `found`.
function readStatement(statement: string, found: Set<string>): void {
  // A language prefix, `q)` or `k)`, as many as are written, `q)k)`, is
  // not what it runs: `k)\l f.q` loads the script (#2034).
  const text = statement.trimStart().replace(/^(?:[qk]\)\s*)+/, "");
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
  // Where the bracket each open one starts closes, -1 for one that does not.
  const closes: number[] = [];
  for (let p = 0, open: number[] = []; p < t.length; p++) {
    if (t[p].kind === "open") {
      closes[p] = -1;
      open.push(p);
    } else if (t[p].kind === "close" && open.length > 0) {
      closes[open.pop() ?? 0] = p;
    }
  }
  // k code, `k)...`, where a monadic `.` or `.:` is `value` (#1448), after
  // the last of the prefixes written, `q)k)."a:1"` (#2034).
  let code = 0;
  while ((t[code]?.text === "k" || t[code]?.text === "q") && t[code + 1]?.text === ")" && touching(t[code], t[code + 1])) code += 2;
  const kCode = code > 0 && t[code - 2].text === "k";
  // What each open bracket is: a lambda, a table literal, its key columns'
  // `[`, or none of them.
  const stack: ("lambda" | "table" | "key" | "other")[] = [];
  let lambdas = 0;
  // The locals of each lambda open around the token: its parameters and the
  // names it assigns plainly anywhere in its body, as q compiles it.
  const locals: Set<string>[] = [];
  // Between `select`, `exec`, `update` or `delete` and its `from`, a name
  // before `:` names a column. A stack, so a query nested in a column's
  // expression closes only itself: `` update c:(exec max a from s) from `t ``.
  const qsql: string[] = [];
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
        throughParameters(t, all, at, closes, i, found);
      }
      // `(a;b):x` assigns each name, globally at the top level.
      // So do `(a):x` and nested lists, `((a;b);c):x` (#1772).
      const names: string[] = [];
      const j = k.text === "(" ? destructured(t, i, names) : -1;
      if (j > 0) {
        if (t[j]?.kind === "op" && t[j].text === ":" && qsql.length === 0) {
          const global = t[j + 1]?.text === ":" && touching(t[j], t[j + 1]);
          for (const name of names) {
            if (lambdas === 0 || global || name.includes(".")) {
              found.add(`assigns ${name}`);
            }
          }
        }
      }
      const amend = k.text === "[" ? amendBefore(t, i) : "";
      if (amend !== "") {
        const args = items(t, i);
        // The target, or with it left out, what the projection is applied
        // to: `` @[;`a;:;1] `. ``, `` .[;();:;5][`a] ``.
        const close = args.length > 0 ? args[args.length - 1][1] : -1;
        const target =
          args[0]?.[0] !== args[0]?.[1]
            ? // The symbol alone, not indexed: `` @[(`t)[0];..] `` is a value.
              t.slice(args[0][0], args[0][1]).filter((k) => k.text !== "(" && k.text !== ")").length === 1
              ? symbolAt(t, i + 1)
              : undefined
            : t[close + 1]?.text === "[" && t[close + 1].kind === "open"
              ? symbolAt(t, close + 2)
              : symbolAt(t, close + 1);
        // Three is an amend too, with a unary, `` @[`t;`c;{x*2}] ``: on a
        // symbol it is never a trap (#1763). `!` takes four.
        if (target !== undefined && target.length > 1 && args.length >= minimum(amend)) {
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
        qsql.push(k.text);
        continue;
      }
      if (k.text === "from" && qsql.length > 0) {
        const table = symbolAt(t, i + 1);
        const query = qsql.pop();
        if ((query === "update" || query === "delete") && table !== undefined) {
          found.add(table === "`." ? "deletes from the root namespace" : `${query === "update" ? "updates" : "deletes from"} ${table} in place`);
        }
        continue;
      }
      // A writer indexed out of its namespace: `` .q[`set][`b;2] ``, and by
      // juxtaposition, `` (.q`set)[`b;2] `` (#1449), and with @ or .,
      // `` (.q@`set)[`b;2] ``, `` (.q . enlist`set)[`b;2] `` (#1726).
      const index =
        (next?.text === "[" || (next?.kind === "op" && next.text === "@")) && t[i + 2]?.kind === "sym"
          ? t[i + 2]
          : next?.kind === "op" && next.text === "." && t[i + 2]?.text === "enlist" && t[i + 3]?.kind === "sym"
            ? t[i + 3]
            : next?.kind === "sym"
              ? next
              : undefined;
      if ((k.text === ".q" || k.text === ".Q") && index !== undefined) {
        const name = `${k.text}.${index.text.slice(1)}`;
        if (CALLED.has(unqualified(name))) {
          found.add(`calls ${name}`);
          continue;
        }
      }
      const name = k.text === ".q" || k.text === ".Q" ? picked(t, i, k.text) : undefined;
      if (name !== undefined) {
        found.add(`calls ${name}`);
        continue;
      }
      // `xasc`, `xdesc` and `xkey` on a table named by a symbol change it in
      // place: `` `a xasc `t ``, `` xasc[`a;`t] ``, and projected on the
      // columns, `` xasc[`a]`t `` and `` xasc[`a][`t] `` (#1447), also
      // `` xasc[`a;]`t ``, `` xasc[`a]@`t ``, `` @[xasc[`a];`t] `` and
      // `` (`a xasc)`t `` (#1725).
      if (["xasc", "xdesc", "xkey"].includes(unqualified(k.text))) {
        // The table a projection ending at `t[close]` is applied to.
        const applied = (close: number): string | undefined =>
          t[close + 1]?.text === "[" && t[close + 1].kind === "open"
            ? symbolAt(t, close + 2)
            : t[close + 1]?.kind === "op" && t[close + 1].text === "@"
              ? symbolAt(t, close + 2)
              : t[close + 1]?.text === ";" && t[i - 1]?.text === "[" && t[i - 2]?.kind === "op" && t[i - 2].text === "@"
                ? symbolAt(t, close + 2)
                : symbolAt(t, close + 1);
        let table = t[i - 1]?.kind === "sym" && t[i - 2]?.text === "(" && next?.text === ")" ? applied(i + 1) : symbolAt(t, i + 1);
        if (next?.text === "[" && next.kind === "open") {
          let depth = 0;
          for (let j = i + 2; j < t.length; j++) {
            if (t[j].kind === "open") depth++;
            else if (t[j].kind === "close" && --depth < 0) {
              table = applied(j);
              break;
            } else if (depth === 0 && t[j].text === ";") {
              table = t[j + 1]?.text === "]" ? applied(j + 1) : symbolAt(t, j + 1);
              break;
            }
          }
        }
        if (table !== undefined && table.length > 1) {
          found.add(`${unqualified(k.text) === "xkey" ? "keys" : "sorts"} ${table} in place with ${k.text}`);
        } else if (
          next !== undefined &&
          (next.text === ")" || next.text === "]" || next.text === ";" || (next.kind === "op" && [..."/\\'@."].includes(next.text)) || next.text === "each" || next.text === "peach")
        ) {
          // Applied some other way - `(xkey)[`a]@`t`, `.[xkey;(`a;`t)]`,
          // `` `a xdesc/: enlist`t ``, `'[::;xdesc][`a;`t]` (#1770) - when its
          // expression holds a symbol for the columns and one for the table.
          const end = expressionEnd(t, i);
          let groups = 0;
          for (let p = expressionStart(t, i); p < end; p++) {
            groups += t[p].kind === "sym" && t[p].text.length > 1 && t[p - 1]?.kind !== "sym" ? 1 : 0;
          }
          if (groups >= 2) {
            found.add(`${unqualified(k.text) === "xkey" ? "keys" : "sorts"} a table in place with ${k.text}`);
          }
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
        // string: `` hopen hsym `f ``, `` hopen `$":f" ``, `hopen ":f"`,
        // `` hopen hsym `$"/tmp/f" ``, and in brackets, `` hopen hsym[`f] `` (#1729).
        const hsym = t[j]?.text === "hsym" ? (t[j + 1]?.text === "[" && t[j + 1].kind === "open" ? 2 : 1) : 0;
        const at = t[j + hsym];
        const cast = at?.text === "`" && t[j + hsym + 1]?.text === "$" && t[j + hsym + 2]?.kind === "str";
        const text =
          at?.kind === "sym" && at.text !== "`"
            ? at.text.slice(1)
            : castHandle(t, j + hsym) || (hsym && cast)
              ? qText(t[j + hsym + 2].text)
              : at?.kind === "str" && !hsym
                ? qText(at.text)
                : undefined;
        const handle = text === undefined ? undefined : text.startsWith(":") ? `\`${text}` : hsym ? `\`:${text}` : undefined;
        if (handle !== undefined && isFileHandle(handle)) {
          found.add(`opens the file ${handle} with ${k.text}`);
        } else if (handle === undefined && ((at?.text === "`" && t[j + 1]?.text === "sv") || at?.text === ".Q.dd")) {
          // Joined into a path: `` hopen ` sv `:d`f ``, `` hopen .Q.dd[`:d;`f] ``;
          // of a process when the first handle in it is one.
          const first = t.slice(j).find((k) => k.kind === "sym" && k.text.startsWith("`:"));
          if (first === undefined || isFileHandle(first.text)) {
            found.add(`opens a file with ${k.text}`);
          }
        } else if (handle === undefined && fileIn(t, i + 1, expressionEnd(t, i))) {
          // Applied some other way, `hopen@`:f`, `(hopen)`:f`, `@[hopen;`:f;h]`,
          // `` hopen -1!`f `` (#1769): a file's handle in its expression.
          found.add(`opens a file with ${k.text}`);
        }
        continue;
      }
      // `reval` runs a tree as `eval` does, an assignment too (#1774).
      if (EVALUATORS.has(unqualified(k.text))) {
        // `(value)"a:1"` applies it as `value "a:1"` does.
        const wrapped = t[i - 1]?.text === "(" && next?.text === ")";
        // Given to a trap, `@[value;"a:1";h]`, `.Q.trp[value;..;h]`, it is
        // applied to the argument after it.
        const trapped = t[i - 1]?.text === "[" && t[i - 1]?.kind === "open" && next?.text === ";";
        // Passed as a value instead - `value/["a:1"]`, `(value@)"a:1"`,
        // `'[value;::]"a:1"`, `@[(value);"a:1";h]` (#1766) - it runs what the
        // expression around it gives it: each string there is read.
        let n = i + 1;
        while (t[n]?.kind === "op" && ["@", ".", "'"].includes(t[n].text)) n++;
        const applied = t[n] !== undefined && (["str", "name", "sym", "num"].includes(t[n].kind) || (t[n].kind === "open" && t[n].text !== "{"));
        const what = evaluates(t, i + (wrapped || trapped ? 1 : 0), unqualified(k.text) !== "eval" && unqualified(k.text) !== "reval", false, applied ? undefined : expressionEnd(t, i));
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
      const column = qsql.length > 0 || ((top === "table" || top === "key") && ["[", "]", ";"].includes(t[i - 1]?.text ?? ""));
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
    // In k, `.` with nothing on its left is `value`: `` k)."a:1" ``, `k).:"a:1"`,
    // and in parentheses, `k)(.)"a:1"`, `k)(.:)"a:1"` (#1728), which q
    // applies the same way: `(.)"a:1"`.
    const unaryDot = k.kind === "op" && k.text === "." && t[i - 1]?.text === "(" && t[i - 1].kind === "open";
    let after = next?.text === ":" && touching(k, next) ? i + 2 : i + 1;
    const parenthesised = unaryDot && t[after]?.text === ")";
    if (parenthesised || (kCode && k.kind === "op" && k.text === "." && i >= code && (t[i - 1].kind === "op" || t[i - 1].kind === "open" || i === code || t[i - 1].text === ";"))) {
      after += parenthesised ? 1 : 0;
      const what = evaluates(t, after - 1, true, kCode);
      if (what !== undefined) {
        found.add(`evaluates ${what.reason} with ${kCode ? "k's ." : "(.)"}`);
        i = what.at;
        continue;
      }
    }
    // `.q` by its symbol, `` (get`.q)`set ``, likewise.
    const name = k.kind === "sym" && (k.text === "`.q" || k.text === "`.Q") ? picked(t, i, k.text.slice(1)) : undefined;
    if (name !== undefined) {
      found.add(`calls ${name}`);
      continue;
    }
    // A writer named by its symbol is the function itself: `` `.q.set . (`a;1) ``,
    // `` (get `.q.set)[`a;1] ``, `` `.q.system "x" ``.
    if (k.kind === "sym" && k.text.startsWith("`.") && CALLED.has(unqualified(k.text.slice(1)))) {
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
      if (target !== undefined && target.length > 1 && items(t, j).length >= minimum(k.text)) {
        found.add(k.text === "!" ? `updates or deletes from ${target} in place with !` : `amends ${target} in place`);
        continue;
      }
    }
    // An operator passed as a value is read as the call it makes (#2036).
    if (k.kind === "op" && VALUES.has(k.text)) {
      for (const call of asValue(t, i)) {
        for (const reason of rereadOf(call)) found.add(reason);
      }
    }
    // A symbol atom left of `?` extends the enumeration it names, and the
    // sym file when it is a handle: `` `sym?`x ``. A list, `` `a`b?`b ``,
    // only finds.
    if (k.kind === "sym" && k.text.length > 1 && next?.kind === "op" && next.text === "?" && t[i - 1]?.kind !== "sym") {
      found.add(`extends the enumeration ${k.text} with ?`);
      continue;
    }
    // Also in parentheses, `` (`sym)?`x ``, and applied, `` ?[`sym;`x] ``
    // (#1773); with four arguments `?[` is a functional select.
    if (k.kind === "op" && k.text === "?") {
      let parens = 0;
      while (t[i - 1 - parens]?.text === ")") parens++;
      const start = i - 1 - 2 * parens;
      const left = parens > 0 && t[start]?.text === "(" && t[start - 1]?.kind !== "sym" ? symbolAt(t, start) : undefined;
      const args = next?.text === "[" && next.kind === "open" ? items(t, i + 1) : [];
      const applied = args.length === 2 && args[0][1] - args[0][0] === 1 ? t[args[0][0]] : undefined;
      const sym = left ?? (applied?.kind === "sym" ? applied.text : undefined);
      if (sym !== undefined && sym.length > 1) {
        found.add(`extends the enumeration ${sym} with ?`);
        continue;
      }
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
    // `-6!` is `eval`, and `-24!` `reval` (#1774).
    if (bang > 0 && (k.text === "-6" || k.text === "-24")) {
      const what = evaluates(t, bang, false);
      if (what !== undefined) {
        found.add(`evaluates ${what.reason} with ${k.text}!`);
        i = what.at;
        continue;
      }
    }
    // Handle 0 is the process itself: `0"a:1"`, `(0)"a:1"`, `neg[0]"a:1"`,
    // `(neg 0)"a:1"` and `-0"a:1"` evaluate the string there, as do
    // `0("a:1")`, `0@"a:1"`, `0 . enlist "a:1"` (#1424) and `0["a:1"]` (#1724).
    // Read as `value` reads them: a list is a tree, `0(@;`b;0;:;9)`, and
    // a call, `0(value;"a:1")` (#1768), and a string that only reads, reads.
    if (k.kind === "num" && /^-?0[ihj]?$/.test(k.text) && t[i - 1]?.kind !== "num") {
      const wrapped =
        (t[i - 1]?.text === "(" && next?.text === ")") ||
        (t[i - 2]?.text === "neg" && t[i - 1]?.text === "[" && next?.text === "]") ||
        (t[i - 2]?.text === "(" && t[i - 1]?.text === "neg" && next?.text === ")");
      const last = wrapped ? i + 1 : i;
      const first = t[last + 1];
      if (first?.kind === "str" || first?.text === "(" || first?.text === "[" || (first?.kind === "op" && ["@", "."].includes(first.text)) || (first?.kind === "name" && first.text === "enlist")) {
        const what = evaluates(t, last, true);
        if (what !== undefined) {
          found.add(`evaluates ${what.reason} on handle 0`);
          i = what.at;
          continue;
        }
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
        } else {
          // Any other handle writes too: `1:` takes a plain symbol for a
          // file name, `` `f 1: 0x00 `` (#2032), and a name may hold one.
          // Only a parse or prepare format - a string, `("SJ";",")` - reads.
          const left = leftArgument(t, i);
          const arg = left !== undefined ? left : first < 0 ? undefined : items(t, first - 1)[0];
          if (arg === undefined || !formatIn(t, arg[0], arg[1])) {
            const sym = arg !== undefined && arg[1] - arg[0] === 1 && t[arg[0]].kind === "sym" ? t[arg[0]].text : undefined;
            found.add(sym !== undefined && sym.length > 1 ? `writes the file ${sym} with ${k.text}:` : `writes a file with ${k.text}:`);
          }
        }
      }
    }
  }
}

/// Text that q `value`s whole, as `LIVE` does a live value's expression:
/// read as `value` reads it, not by a script's rules. To `value` a line that
/// is `/` alone is a comment to its end, not a block comment, and a `\` line
/// ends nothing, so `(1;\n/\nd:9)` assigns `d` (#2033).
export interface Valued {
  valued: string;
}

/// `text` to be read as `value` reads it.
export function valued(text: string): Valued {
  return { valued: text };
}

/// Code the guard reads: a script's text, or so many pieces each sent on
/// its own, a piece `value`d whole marked so.
export type GuardCode = string | readonly (string | Valued)[];

/// The text of `code`, its pieces on lines of their own, to show.
export function guardText(code: GuardCode): string {
  return typeof code === "string" ? code : code.map((p) => (typeof p === "string" ? p : p.valued)).join("\n");
}

/// What `code` does that the guard asks about, each said once, in the
/// order found: `assigns trade`, `runs the system command \l`. Empty when
/// it only reads, as far as its text shows. A list is code sent as so many
/// pieces, each read on its own: a `\` or `/` line ending one does not hide
/// the next (#1442); one `value`d whole is read as one statement.
export function writes(code: GuardCode): string[] {
  if (nesting++ === 0) {
    rereads = 0;
  }
  try {
    const found = new Set<string>();
    for (const piece of typeof code === "string" ? [code] : code) {
      if (typeof piece !== "string") {
        readStatement(piece.valued, found);
        continue;
      }
      for (const statement of statements(piece)) {
        readStatement(statement, found);
      }
    }
    return [...found];
  } finally {
    nesting--;
  }
}

/// What the guard holds `code` to on `targets`: the guarded ones, each with
/// the tags it is guarded by, and what the code does. Undefined when it
/// may be sent unasked.
export function guardCheck(code: GuardCode, targets: Pick<Process, "label" | "tags">[], settings: GuardSettings): { guarded: { label: string; tags: string[] }[]; reasons: string[] } | undefined {
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
