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
// be changed needs its own `.z.pg`. Its backstop: what it reads as
// read-only goes to a guarded process under `reval` (`readEnforce`), so q
// refuses a write it missed - all but a breakpoint, which it must catch.
//
// The rules, outside strings and comments:
// - `name:`, `name::`, `name+:` and `name[i]:` at the top level, and
//   `name::`, a dotted `.ns.name:`, or `name+:` or `name[i]:` to a name that
//   is not one of its locals inside a lambda, where q makes them global.
//   A column named in `select a:x from t` or `([] a:1 2)` is not an
//   assignment, but one inside a column's expression (`([] c:g:1)`) is;
//   `(a;b):x` assigns each name, by the same rules, as do `(a):x` and
//   `((a;b);c):x` (#1772);
// - an assignment written as a call, `:[a;77]`, `(+:)[a;1]`, by the same
//   rules, to its first argument (#2264);
// - `update` or `delete` from a table named by a symbol (`` from `t ``,
//   `` from (`t) ``), which changes it in place;
// - `set`, `upsert`, `insert`, `hdel`, `exit`, `hclose`, `system`,
//   `setenv`, `save`, `rsave`, `dsave`, `load`, `rload`, `.Q.dpft`,
//   `.Q.dpfts`, `.Q.dpt`, `.Q.dpts`, `.Q.hdpf`, `.Q.en`, `.Q.ens`,
//   `.Q.enx`, `.Q.enxs`, `.Q.chk`, `.Q.dsftg`, `.Q.view`, `.Q.l`, `.Q.lo`,
//   `.Q.li`, `.Q.bv`, `.Q.L`, `.Q.Xf` (which creates a file), `.Q.opt` (which
//   sets `.Q.x`), KDB-X's `use` (which runs a module), `.h.ht` (which
//   writes HTML files) (#1775), the debugger's `.Q.bs`, `.Q.bc`, `.Q.bd`,
//   `.Q.bu`, `.Q.bp` and `.Q.Ls`, which patch a function's code (#2276), and `0:` or `1:` to a
//   file handle (`` `:f 0: ``, `hsym[`f] 0:`, `(hsym `f) 1:`,
//   `` (`$":f") 0: ``, `` 0:[`:f;x] ``, `` .[0:;(`:f;x)] ``) - or to
//   anything else but a parse or prepare format (`"," 0: t`,
//   `("SJ";",") 0: f`): `1:` takes a plain symbol for a file, and a name
//   may hold a handle (#2032) - and `2:`,
//   each also by its `.q.` name (`.q.set`), by its symbol
//   (`` `.q.set . (`a;1) ``), one cast from a string too (`` (`$".q.set") ``,
//   #2037), and picked from `.q`, `.Q` or `.h` (#2272) by any index
//   (`` .q[`set] ``, `` (get`.q)`set ``, #1765) or by an index it cannot
//   read, `` .q[`$"se","t"] ``, `((value .q) 71)` (#2206), and got with
//   `parse` or `-5!`, `(parse"set")[`a;1]` (#2205) - as are `value`,
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
//   `` .[?;(`sym;`x)] ``), read as the call it makes (#2036), projected
//   and applied after too, `` (?)[`sym] `x `` (#2188);
// - a string or a list sent to handle 0 (`0"a:1"`, `neg[0]"a:1"`,
//   `0(@;`b;0;:;9)`), or what a function gives, `0 raze("a:";"1")` (#2204),
//   which the process evaluates itself as `value` would;
// - `-11!`, which replays a log through `upd`, except `-11!(-1;..)` and
//   `-11!(-2;..)`, which only count and check one; `-19!`, which
//   compresses a file into another - each also spaced or with the number
//   in parentheses (`-19 !x`, `(-19)!x`), with a type, `-11j!`, or computed,
//   `(neg 11)!x` - one it cannot work out is asked about (#2208); `-104!`, which
//   patches a function's code (#2276) - and with `!` passed as a value
//   (`` (!)[-11;`:log] ``, `` .[!;(-19;..)] ``, `` !/[-11;`:log] ``, #2041);
// - `@[` or `.[` on a variable named by a symbol, alone or in
//   parentheses (`` .[(`t);..] ``), with three arguments or four: an
//   amend in place - on a symbol it is never a trap, `.[`f;args;h]`
//   amends `f` or fails (#1763); `![` with four likewise, a functional
//   update or delete. Also through an adverb or applied first in a
//   composition (`` @/[`.;`a;:;9] ``, `` '[::;@][..] ``), with the target left
//   out and given after (`` @[;`a;:;1] `. ``), the projection in parentheses
//   too and applied by `each`, an adverb, `@` or `.` (`` (.[;();:;1]) `a ``,
//   `` (.[;();:;1]) each `a`b ``, #2038), and the amend or `!`
//   passed as a value (`` .[@;(`.;`a;:;1)] ``, `` (@) . (`.;..) ``);
// - `value`, `get`, `eval`, `reval`, `.h.val` (#2273), `-6!` or `-24!`, or in k code a monadic `.`
//   (`` k)."a:1" ``), applied to a string that changes the process by these
//   rules, read whole as `value` reads it, not as a script (#2274) - `value "count t"` reads (#1776) - or one built or passed through
//   another function (`value "a",":1"`), or made without a string written,
//   `` value string`a:1 ``, `` get`char$97 58 49 `` (#2203), to `parse` or
//   `-5!`, or to a tree headed by `:`, `::` or `+:` (`eval(:;`t;())`), by
//   an amend `@` or `.` of four items or more on a variable by name
//   (`` value(@;`.;`a;:;1) ``, `` eval(@;enlist`.;enlist`a;:;1) ``), by
//   `!` on a table by name (`` eval(!;enlist`t;..) ``, `` value(!;`t;..) ``)
//   or by the symbol of
//   a writer above (`` value(`.q.set;`a;1) ``), or by anything that, called
//   on the rest, changes the process (`value(hopen;`:f)`,
//   `value(value;"a:1")`, #1767), a lambda among them,
//   `` value({.[x;();:;1]};`a) `` (#2195), also through `[`,
//   `each`, `'`, `@`, `.` or `enlist`, in parentheses (`(value)"a:1"`)
//   and through a trap (`@[value;"a:1";h]`), and by their `.q.` names;
//   passed as a value, through an adverb or a composition (`value/["a:1"]`,
//   `'[value;::]"a:1"`), each string in the expression around it (#1766);
// - in k code, `~`, `<` and `>` with nothing on their left - `hdel`,
//   `hopen` and `hclose` - on a file, a handle or a name (#2275);
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
//   which runs it on the gateway's servers (#909), given to `.` or `@` or
//   any function, `.[.gw.syncexec;("a:1";`rdb)]` (#2187), and a query there that
//   is not strings written in the call - a list the servers evaluate, a
//   name, one built or given later, `.gw.syncexec[;`rdb] "a:1"` (#2039) -
//   and one headed by a lambda that, applied to the rest, changes them,
//   `({value raze x};("a";":1"))` (#2186).
// - code in a language other than q and k: KDB-X SQL after `s)`, read as
//   the SQL tab reads it, `s)drop table t`, and anything else not read at
//   all, Python after `p)` or given to `.p.e`, `.pykx.pyexec` (#2197, #2209);
// - where an argument that decides whether code writes - the target of an
//   amend, `update`, `xasc` or `?`, the handle `hopen` opens - is not one
//   the guard can read, it is taken for one that writes: a symbol computed,
//   `` @[first`b;0;+;1] ``, `` update a:1 from `$"t" ``, a handle made,
//   `` .[hsym`f;();:;1] ``, `` hopen hsym first`f ``, a local holding one,
//   `` {s:`a;.[s;();:;1]}[] ``, or each item of `` enlist`a `` (#2198-#2202,
//   #2207); a name alone is the value it holds;
// Code too long or too deeply nested to read within the guard's bounds, or
// that it fails to read, is asked about: the bounds keep a read well under
// 100 ms, and the answer is the code's alone, not what was read before
// (#2190, #2210, #2211).
import { parseTags, type Process } from "./processes";
import { sqlWrites } from "./sql";
import { statements } from "./statements";

export interface GuardSettings {
  enabled: boolean;
  /// Lower case.
  tags: string[];
}

export const DEFAULT_GUARD_TAGS = ["prod", "prd", "production"];

/// The settings read as `readLive` reads the query ones, at each send. A
/// tag list that is not a list of strings is the default one; an empty
/// list guards nothing. Each tag is read as a process's tags are, by
/// `parseTags`: one with a blank or a comma in it is a tag for each word,
/// since no process can carry it whole - `live desk` guards a process
/// tagged `live` and one tagged `desk` (#2040).
export function readGuard(get: <T>(key: string, fallback: T) => T): GuardSettings {
  const tags = get<unknown>("processes.readOnlyGuard.tags", DEFAULT_GUARD_TAGS);
  return {
    enabled: get<unknown>("processes.readOnlyGuard.enable", true) !== false,
    tags: Array.isArray(tags) && tags.every((t) => typeof t === "string") ? parseTags(tags.join(" ")) : DEFAULT_GUARD_TAGS,
  };
}

/// Whether code the guard lets be sent unasked to a process it guards goes
/// under `reval` (`query.ts`'s `trapLines`), q's own read-only evaluation,
/// so a write the guard missed is refused by q: on unless
/// `q-lint.processes.readOnlyGuard.enforce` is false, and only while the
/// guard is on.
export function readEnforce(get: <T>(key: string, fallback: T) => T): boolean {
  return readGuard(get).enabled && get<unknown>("processes.readOnlyGuard.enforce", true) !== false;
}

/// The tags of `process` the guard guards it by; empty when it is not
/// guarded, or the guard is off. A tag is read as `readGuard` reads the
/// setting's, so one that holds a blank, `Live Desk`, is guarded by either
/// word.
export function guardedBy(process: Pick<Process, "tags">, settings: GuardSettings): string[] {
  if (!settings.enabled) {
    return [];
  }
  return process.tags.filter((tag) => parseTags(tag).some((word) => settings.tags.includes(word)));
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
  /// Where it is among the statement's tokens, spaces too.
  n: number;
}

/// What each ASCII character may be in a token, as bits: a letter, a
/// digit, `_`, `.`, `:`, white space. Tested by code, not by a pattern, as
/// the guard reads every character of what is sent, often more than once.
const LETTER = 1;
const DIGIT = 2;
const UNDERSCORE = 4;
const DOT = 8;
const COLON = 16;
const SPACE = 32;
const CLASS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  CLASS[c] = (/[A-Za-z]/.test(ch) ? LETTER : 0) | (/[0-9]/.test(ch) ? DIGIT : 0) | (ch === "_" ? UNDERSCORE : 0) | (ch === "." ? DOT : 0) | (ch === ":" ? COLON : 0) | (/\s/.test(ch) ? SPACE : 0);
}
/// Whether the character at `code[i]` is any of `bits`; past the end, none.
function is(code: string, i: number, bits: number): boolean {
  const c = code.charCodeAt(i);
  return c < 128 ? (CLASS[c] & bits) !== 0 : c === c && (bits & SPACE) !== 0 && /\s/.test(code[i]);
}
/// The characters that make a compound assignment with `:` after them.
const OPERATORS = new Set([..."+-*%&|^=<>$,#_~!?@."]);
const WRITERS = new Set([
  "set", "upsert", "insert", "hdel", "exit", "hclose", "system", "save", "rsave", "dsave", "load", "rload", "setenv",
  ".Q.dpft", ".Q.dpfts", ".Q.dpt", ".Q.dpts", ".Q.hdpf", ".Q.en", ".Q.ens", ".Q.enx", ".Q.enxs", ".Q.chk", ".Q.dsftg",
  ".Q.view", ".Q.l", ".Q.lo", ".Q.li", ".Q.bv", ".Q.opt", ".Q.Xf", ".Q.L", "use", ".h.ht",
  // The debugger's breakpoints patch a function's code in place, which
  // `reval` does not stop (#2276).
  ".Q.bs", ".Q.bc", ".Q.bd", ".Q.bu", ".Q.bp", ".Q.Ls",
]);
/// What evaluates a string or a parse tree it is given: `.h.val` is q's own
/// alias of `value` (#2273).
const EVALUATORS = new Set(["value", "get", "eval", "reval", ".h.val"]);
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
      const tail = out.slice(-4).filter((k) => k.kind !== "space");
      const cast = tail.length >= 2 && tail[tail.length - 1].text === "$" && tail[tail.length - 2].kind === "sym" && tail[tail.length - 2].text === "`";
      if (cast) {
        const start = out.lastIndexOf(tail[tail.length - 2]);
        out.splice(start, out.length - start, { kind: "sym", text: `\`${qText(text)}`, pos: tail[tail.length - 2].pos, n: start });
      } else {
        out.push({ kind: "str", text, pos: i, n: out.length });
      }
      i = j + 1;
    } else if (c === "/" && (i === 0 || is(code, i - 1, SPACE))) {
      while (i < code.length && code[i] !== "\n") {
        i++;
      }
    } else if (is(code, i, SPACE)) {
      let j = i;
      while (j < code.length && is(code, j, SPACE)) {
        j++;
      }
      out.push({ kind: "space", text: code.slice(i, j), pos: i, n: out.length });
      i = j;
    } else if (c === "`") {
      let j = i + 1;
      const path = code[j] === ":";
      while (j < code.length && (is(code, j, LETTER | DIGIT | UNDERSCORE | DOT | COLON) || (path && code[j] === "/"))) {
        j++;
      }
      out.push({ kind: "sym", text: code.slice(i, j), pos: i, n: out.length });
      i = j;
    } else if (is(code, i, DIGIT) || (c === "-" && is(code, i + 1, DIGIT) && (out.length === 0 || out[out.length - 1].kind !== "name"))) {
      let j = i + 1;
      while (j < code.length && is(code, j, DIGIT | LETTER | DOT)) {
        j++;
      }
      out.push({ kind: "num", text: code.slice(i, j), pos: i, n: out.length });
      i = j;
    } else if (is(code, i, LETTER | DOT) && !(c === "." && !is(code, i + 1, LETTER | DOT))) {
      let j = i + 1;
      while (j < code.length && is(code, j, LETTER | DIGIT | UNDERSCORE | DOT)) {
        j++;
      }
      out.push({ kind: "name", text: code.slice(i, j), pos: i, n: out.length });
      i = j;
    } else if ("([{".includes(c)) {
      out.push({ kind: "open", text: c, pos: i, n: out.length });
      i++;
    } else if (")]}".includes(c)) {
      out.push({ kind: "close", text: c, pos: i, n: out.length });
      i++;
    } else {
      out.push({ kind: "op", text: c, pos: i, n: out.length });
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
  scanned(end - open);
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
  scanned(to - from);
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
  scanned(at - open);
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

/// The whole number `t[from]` to `t[to]` comes to, read as q reads it, from
/// the right - numbers, `-`, `+`, `*`, `neg` and parentheses - or undefined:
/// `neg 11` and `0-11` are -11.
function constant(t: Token[], from: number, to: number): number | undefined {
  const value = (p: number, end: number): [number, number] | undefined => {
    let left: number;
    let next: number;
    const k = t[p];
    if (k === undefined || p >= end) return undefined;
    if (k.kind === "num" && /^-?\d+[ihj]?$/.test(k.text)) {
      left = parseInt(k.text, 10);
      next = p + 1;
    } else if (k.kind === "name" && k.text === "neg") {
      const inner = t[p + 1]?.text === "[" ? value(p + 2, (items(t, p + 1).at(-1)?.[1] ?? end)) : value(p + 1, end);
      if (inner === undefined) return undefined;
      return t[p + 1]?.text === "[" ? [-inner[0], (items(t, p + 1).at(-1)?.[1] ?? end) + 1] : [-inner[0], inner[1]];
    } else if (k.kind === "open" && k.text === "(") {
      const close = items(t, p).at(-1)?.[1] ?? end;
      const inner = value(p + 1, close);
      if (inner === undefined || inner[1] !== close) return undefined;
      left = inner[0];
      next = close + 1;
    } else {
      return undefined;
    }
    if (next >= end) return [left, next];
    // `0-11`, read here as two numbers, is a subtraction in q.
    if (t[next].kind === "num" && t[next].text.startsWith("-") && t[next].n === t[next - 1].n + 1 && next + 1 === end && /^-\d+[ihj]?$/.test(t[next].text)) {
      return [left + parseInt(t[next].text, 10), end];
    }
    const op = t[next];
    if (op.kind !== "op" || !["-", "+", "*"].includes(op.text)) return undefined;
    const right = value(next + 1, end);
    if (right === undefined) return undefined;
    return [op.text === "-" ? left - right[0] : op.text === "+" ? left + right[0] : left * right[0], right[1]];
  };
  if (to - from > 16) return undefined;
  const read = value(from, to);
  return read !== undefined && read[1] === to ? read[0] : undefined;
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
        scanned(j - open);
        return out;
      }
    } else if (depth === 0 && t[j].text === ";") {
      out.push([start, j]);
      start = j + 1;
    }
  }
  out.push([start, t.length]);
  scanned(t.length - open);
  return out;
}

/// Where the list of names that opens at `t[open]` ends - past its `)` - when
/// it holds only names and lists of them, `((a;b);c)`, with each name added
/// to `names`; -1 otherwise, and for lists nested deeper than 16.
function destructured(t: Token[], open: number, names: string[]): number {
  // Without recursion, so no depth of parentheses overflows the stack (#2211).
  let j = open + 1;
  let depth = 1;
  const start = names.length;
  for (;;) {
    if (t[j]?.kind === "name") {
      names.push(t[j].text);
      j++;
    } else if (t[j]?.text === "(" && t[j].kind === "open" && depth < 16) {
      depth++;
      j++;
      continue;
    } else {
      names.length = start;
      return -1;
    }
    while (t[j]?.text === ")" && depth > 0) {
      depth--;
      j++;
      if (depth === 0) return j;
    }
    if (t[j]?.text !== ";") {
      names.length = start;
      return -1;
    }
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
    scanned(p - o);
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

/// The functions that give a symbol from what may not be one - a handle,
/// `hsym`, `.Q.dd`; a name, `key`, `cols`, `tables`, `views`; anything, the
/// evaluators and `parse` - so a target computed with one may be by name.
const SYMBOLIC = new Set(["hsym", ".Q.dd", "key", "cols", "tables", "views", "value", "get", "eval", "reval", "parse"]);
/// What never gives a symbol, whatever it is given.
const NOT_SYMBOLS = new Set(["enlist", "read0", "read1", "string", "count", "type", "til", "md5", "meta", "flip", "null", "not", "neg", "abs", "sum", "avg", "lower", "upper"]);
/// What gives the symbols it is given, or one of them: `` first`t ``.
const KEEPS = new Set(["first", "last", "reverse", "distinct", "raze", "asc", "desc", "min", "max", "inter", "except", "union", "sublist", "rotate", "cut", "sv"]);
/// The operators that do, between two values: `` `t,`u ``, `` 1#`t ``.
const KEEPS_OPS = new Set([",", "#", "_", "^", "&", "|"]);
/// The keywords written between their arguments.
const INFIX = new Set([
  "and", "or", "mod", "div", "xbar", "xexp", "xlog", "xprev", "rotate", "sublist", "cut", "in", "within", "like", "ss", "sv", "vs", "except", "inter", "union",
  "bin", "binr", "set", "upsert", "insert", "xasc", "xdesc", "xkey", "xcol", "xcols", "lj", "ij", "uj", "pj", "ej", "asof", "cross", "mmu", "lsq", "wavg", "wsum",
  "cor", "cov", "scov", "each", "peach", "over", "scan", "prior", "mavg", "msum", "mmax", "mmin", "mdev", "mcount", "ema", "fby", "dsave",
]);
/// What gives a table from columns named by symbols on its left: `` `a xasc t ``.
const BY_COLUMNS = new Set(["xasc", "xdesc", "xkey", "xcol", "xcols"]);

/// `[from, to)` past the parentheses that hold all of it: `((x))` is `x`.
function unwrapped(t: Token[], from: number, to: number): [number, number] {
  while (to - from > 2 && t[from].text === "(" && t[from].kind === "open" && t[to - 1].text === ")") {
    const all = items(t, from);
    if (all.length !== 1 || all[0][1] !== to - 1) break;
    from++;
    to--;
  }
  return [from, to];
}

/// Whether the expression `t[from]` to `t[to]`, where an argument decides
/// whether code writes - the target of an amend, `update`, `xasc` or `?` -
/// may give a symbol, which names a global or a file: the guard asks when
/// it cannot tell (#2198). Read as q does, from its first term: a symbol
/// written, `` `t ``, an item of a list of them, `` `t`u 0 ``, `` `t`u@0 ``,
/// `` (`t;`u)0 ``, `` (`k!enlist`t)`k ``, one cast, `` `$string`t ``,
/// `"S"$x`, what a function keeps a symbol through gives, `` first`t ``,
/// `` reverse`t ``, `` `t`u inter`t ``, `` 1#`t ``, what one that may make a
/// symbol gives, `hsym`, `.Q.dd`, `key`, `value`, `-1!`, a lambda's body
/// applied, `` {`t}[] ``, and a lambda's local that holds one, `held`
/// (#2200). A name alone is the value it holds, as anywhere else in the
/// guard; a list of symbols, `` `a`b ``, a dictionary made with them,
/// `` `a`b!1 2 ``, a symbol indexed, `` `t 0 ``, which is its variable's
/// item, `select` and a table sorted or keyed, `` `a xasc t ``, are values.
function symbolic(t: Token[], from: number, to: number, held: ReadonlySet<string> | undefined): boolean {
  [from, to] = unwrapped(t, from, to);
  if (from >= to) {
    return false;
  }
  scanned(to - from);
  const k = t[from];
  // The first term, `[from, end)`: a run of symbols, a name or a group with
  // the brackets applying it, a lambda, a string, a run of numbers.
  let end = from + 1;
  if (k.kind === "sym") {
    while (end < to && t[end].kind === "sym") end++;
  } else if (k.kind === "num") {
    while (end < to && t[end].kind === "num") end++;
  } else if (k.kind === "open") {
    end = (items(t, from).at(-1)?.[1] ?? to) + 1;
  }
  const bracket = k.kind !== "sym" && k.kind !== "num" && t[end]?.text === "[" && t[end].kind === "open" ? end : -1;
  const termEnd = bracket >= 0 ? (items(t, bracket).at(-1)?.[1] ?? to) + 1 : end;
  const next = t[termEnd];
  // `x op y`: what the operator gives.
  const infix = next !== undefined && termEnd < to && (next.kind === "op" || (next.kind === "name" && INFIX.has(next.text)));
  const keeps = infix && (KEEPS_OPS.has(next.text) || KEEPS.has(next.text));
  const after = (): boolean => symbolic(t, termEnd + 1, to, held);
  if (k.kind === "sym") {
    const vector = end - from > 1;
    if (termEnd >= to) return !vector && k.text.length > 1;
    if (!vector && next.kind === "op" && next.text === "$") return true;
    if (infix && BY_COLUMNS.has(unqualified(next.text))) return after();
    if (infix) return keeps || (vector && next.text === "@");
    // Juxtaposed: an item of a list of symbols, or of the variable named.
    return vector;
  }
  if (k.kind === "num") {
    if (k.text === "-1" && next?.text === "!") return true;
    return infix && ["#", "_", "sublist", "rotate"].includes(next.text) && after();
  }
  if (k.kind === "str") {
    return next?.kind === "op" && next.text === "$" && termEnd < to;
  }
  if (k.kind === "open" && k.text === "{") {
    // A lambda applied gives what its body does.
    // A lambda applied gives what its body does; projected, `{[a;b]..}[a]`, it
    // is a function.
    const named = t[from + 1]?.text === "[" && t[from + 1].kind === "open" ? items(t, from + 1).filter(([a, b]) => a < b).length : 0;
    const given = bracket >= 0 ? items(t, bracket).filter(([a, b]) => a < b).length : 1;
    return (bracket >= 0 || (termEnd < to && !infix)) && given >= named && tokenSymbolic(t, from + 1, end - 1, held);
  }
  if (k.kind === "open") {
    const list = items(t, from);
    if (termEnd >= to) return false;
    if (infix) return keeps && (list.some(([a, b]) => symbolic(t, a, b, held)) || after());
    // Indexed: an item of the list or dictionary in it, or of the variable
    // a symbol in it names, `` (`d)`a ``.
    if (list.length === 1 && list[0][1] - list[0][0] === 1 && t[list[0][0]].kind === "sym") return false;
    return list.some(([a, b]) => tokenSymbolic(t, a, b, held));
  }
  if (k.kind === "name") {
    const name = unqualified(k.text);
    if (name === "select" || NOT_SYMBOLS.has(name)) return false;
    if (held?.has(k.text) ?? false) return true;
    // (A function alone is that function: `@[value;x;h]` traps.)
    if (termEnd >= to && bracket < 0) return false;
    if (SYMBOLIC.has(name)) return true;
    if (bracket >= 0) {
      const first = items(t, bracket)[0];
      return KEEPS.has(name) && itemSymbolic(t, first[0], first[1], held);
    }
    if (termEnd >= to) return false;
    if (infix) return keeps && after();
    // `` first`zz`t ``: an item of what it is given.
    return KEEPS.has(name) && itemSymbolic(t, termEnd, to, held);
  }
  return false;
}

/// Whether a symbol, a cast or a function that may make one is anywhere in
/// `t[from]` to `t[to]` outside brackets, a lambda's body or a dictionary's
/// keys: a list or a dictionary holding one gives it when it is indexed.
function tokenSymbolic(t: Token[], from: number, to: number, held: ReadonlySet<string> | undefined): boolean {
  scanned(to - from);
  let depth = 0;
  for (let p = from; p < to; p++) {
    const k = t[p];
    if (k.kind === "open") depth++;
    else if (k.kind === "close") depth--;
    else if (
      depth === 0 &&
      ((k.kind === "sym" && t[p + 1]?.text !== "!" && (k.text.length > 1 || t[p + 1]?.text === "$")) ||
        (k.kind === "op" && k.text === "$" && t[p + 1]?.text !== "[") ||
        (k.kind === "name" && (SYMBOLIC.has(unqualified(k.text)) || (held?.has(k.text) ?? false))))
    ) {
      return true;
    }
  }
  return false;
}

/// Whether an item of the expression `t[from]` to `t[to]`, which something
/// is applied to each of, may be a symbol by `symbolic`: of `` enlist`t ``,
/// `` `t ``; of `` `a`b `` either (#2201).
function itemSymbolic(t: Token[], from: number, to: number, held: ReadonlySet<string> | undefined): boolean {
  [from, to] = unwrapped(t, from, to);
  if (t[from]?.kind === "name" && t[from].text === "enlist") {
    return symbolic(t, from + 1, to, held);
  }
  if (to - from > 1 && t.slice(from, to).every((k) => k.kind === "sym")) {
    return true;
  }
  const list = listed(t, from, to);
  return list !== undefined && t[from].text === "(" ? list.some(([a, b]) => symbolic(t, a, b, held)) : symbolic(t, from, to, held);
}

/// `[from, to)` as it is shown in a reason: short.
function shown(t: Token[], from: number, to: number): string {
  const text = joined(t, from, to);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/// Whether the handle `t[from]` to `t[to]` is one the guard cannot read: made
/// - `hsym`, `.Q.dd`, `` ` sv ``, `-1!`, a cast, a string, a lambda - or held
/// by a local, or any symbol but a process's (#2207). A name or a number
/// alone, and a process's handle with a timeout, `` (`:h:5000;1000) ``, are not.
function madeHandle(t: Token[], from: number, to: number, held: ReadonlySet<string> | undefined): boolean {
  [from, to] = unwrapped(t, from, to);
  if (to - from === 1) {
    return t[from].kind === "name" && (held?.has(t[from].text) ?? false);
  }
  scanned(to - from);
  for (let p = from; p < to; p++) {
    const k = t[p];
    // `hsym`, `-1!` or `.Q.dd` of a symbol written: the symbol says.
    const made = (k.kind === "name" && ["hsym", ".Q.dd"].includes(unqualified(k.text))) || (k.kind === "num" && k.text === "-1" && t[p + 1]?.text === "!");
    const of = t[p + (k.kind === "num" ? 2 : 1)];
    if (
      (k.kind === "sym" && (k.text === "`" || isFileHandle(k.text.startsWith("`:") ? k.text : `\`:${k.text.slice(1)}`))) ||
      (k.kind === "op" && k.text === "$") ||
      k.kind === "str" ||
      (k.kind === "open" && k.text === "{") ||
      (made && of?.kind !== "sym" && !(of?.kind === "open" && t[p + 2]?.kind === "sym")) ||
      (k.kind === "name" && !made && (SYMBOLIC.has(unqualified(k.text)) || (held?.has(k.text) ?? false)))
    ) {
      return true;
    }
  }
  return false;
}

/// What the function at `t[i]` is applied to, its first argument: written
/// after it, `f x`, `f[x]`, `f@x`, `f . (x;y)`, through `each` or an adverb,
/// in parentheses, `(f)x`, or given with it to a trap or `.`/`@`,
/// `@[f;x;h]`, `.[f;enlist x;h]`. Undefined when it is not applied here.
function argumentOf(t: Token[], i: number): [number, number] | undefined {
  let s = i;
  let e = i;
  while (t[s - 1]?.text === "(" && t[s - 1].kind === "open" && t[e + 1]?.text === ")") {
    s--;
    e++;
  }
  if (t[s - 1]?.text === "[" && t[s - 1].kind === "open" && (t[s - 2]?.text === "@" || t[s - 2]?.text === ".") && t[s - 2].kind === "op" && t[e + 1]?.text === ";") {
    const arg = items(t, s - 1)[1];
    if (arg === undefined || arg[0] === arg[1]) return undefined;
    return t[s - 2].text === "." ? (listed(t, arg[0], arg[1])?.[0] ?? arg) : arg;
  }
  let q = e + 1;
  while (t[q]?.kind === "op" && ["'", "/", "\\", ":"].includes(t[q].text)) q++;
  if (t[q]?.kind === "name" && ITERATORS.has(t[q].text)) q++;
  const k = t[q];
  if (k === undefined) return undefined;
  if (k.kind === "op" && (k.text === "@" || k.text === ".")) {
    const end = argumentEnd(t, q);
    if (end <= q + 1) return undefined;
    return k.text === "." ? (listed(t, q + 1, end)?.[0] ?? [q + 1, end]) : [q + 1, end];
  }
  if (k.kind === "open" && k.text === "[") {
    const first = items(t, q)[0];
    return first[0] < first[1] ? first : undefined;
  }
  if (["str", "sym", "num", "name"].includes(k.kind) || (k.kind === "open" && k.text !== "[")) {
    const end = argumentEnd(t, q - 1);
    return end > q ? [q, end] : undefined;
  }
  return undefined;
}

/// The symbols the lambda opening at `t[open]` assigns to its locals:
/// `{s:`t; update a:1 from s}` updates `t` (#2200). A local is held when
/// what it is assigned may give a symbol, by `symbolic`.
function heldLocals(t: Token[], open: number, close: number, touching: (a: Token | undefined, b: Token | undefined) => boolean): Set<string> {
  const held = new Set<string>();
  if (close < 0) return held;
  scanned(close - open);
  for (let p = open + 1, nested = 0; p < close; p++) {
    const k = t[p];
    if (k.kind === "open" && k.text === "{") nested++;
    else if (k.kind === "close" && k.text === "}") nested--;
    else if (nested === 0 && k.kind === "name" && t[p + 1]?.kind === "op" && t[p + 1].text === ":" && !(t[p + 2]?.text === ":" && touching(t[p + 1], t[p + 2]))) {
      if (symbolic(t, p + 2, argumentEnd(t, p + 1), held)) held.add(k.text);
    }
  }
  return held;
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
  scanned(i - open);
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
      // (`enlist` heading a tree, `(enlist;(:;`a;77))`, is its head.)
      (t[j].kind === "name" && ["each", "peach", "enlist"].includes(t[j].text) && !(t[j - 1]?.text === "(" && t[j + 1]?.text === ";")) ||
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
  // (`(::)` alone is the identity, not an assignment.) The tree's items are
  // counted past the head's own parentheses, `eval((:);`a;77)` (#2265).
  const reason = head && k?.kind === "op" && (k.text === ":" || (OPERATORS.has(k.text) && t[j + 1]?.text === ":")) && items(t, j - 1 - wrap).length > 1
    ? "an assignment"
    : head && k?.text === "!" && t[j + 1]?.text === ";" && (byValue ? t[j + 2] : t[j + 2]?.text === "enlist" ? t[j + 3] : undefined)?.kind === "sym"
      ? "a functional update or delete"
      : head && k?.kind === "sym" && WRITERS.has(unqualified(k.text.slice(1)))
        ? `a call of ${k.text.slice(1)}`
        : // An amend on a variable by name: `` value(@;`.;`a;:;1) ``,
          // `` eval(@;enlist`.;enlist`a;:;1) `` (#1446).
          (head && (k?.text === "@" || k?.text === ".") && named(j + 1 + wrap)?.kind === "sym" && (named(j + 1 + wrap)?.text.length ?? 0) > 1 && items(t, j - 1 - wrap).length > minimum(k?.text ?? "")) || projected
          ? "an amend"
          : (called(t, lists, byValue) ?? (byValue || !head ? undefined : nested(t, j - 1 - wrap)));
  return reason === undefined ? undefined : { reason, at: j };
}

/// What an evaluator at `t[i]` passed as a value - in parentheses,
/// through an iterator or a composition, an item of a list, given to a
/// function - would run on a tree in the expression around it, which it
/// may be applied to: `((eval))(:;`a;77)`, `'[eval;::](:;`a;77)`,
/// `{x y}[eval;(count;(:;`a;77))]` (#2266). Lists in a lambda there are
/// that lambda's.
function treesAround(t: Token[], i: number, byValue: boolean): { reason: string; at: number } | undefined {
  const end = expressionEnd(t, i);
  scanned(end - i);
  for (let p = expressionStart(t, i), lambda = 0; p < end; p++) {
    if (t[p].kind === "open" && t[p].text === "{") lambda++;
    else if (t[p].kind === "close" && t[p].text === "}") lambda--;
    else if (lambda === 0 && t[p].kind === "open" && t[p].text === "(") {
      const what = evaluated(t, p, byValue);
      if (what !== undefined) return { reason: what.reason, at: i };
    }
  }
  return undefined;
}

/// What a list in the tree opening at `t[open]` does that changes the
/// process, `eval` evaluating each list in a tree before applying its
/// head: `eval(+;0;(:;`a;77))` assigns `a` (#2265). Not `value`'s, which
/// takes a list's items as they are.
function nested(t: Token[], open: number): string | undefined {
  const end = items(t, open).at(-1)?.[1] ?? open;
  scanned(end - open);
  for (let p = open + 1; p < end; p++) {
    if (t[p].kind === "open" && t[p].text === "{") {
      // A lambda in the tree is a value until it is applied: `called` reads that.
      let depth = 0;
      for (; p < end; p++) {
        if (t[p].kind === "open") depth++;
        else if (t[p].kind === "close" && --depth === 0) break;
      }
    } else if (t[p].kind === "open" && t[p].text === "(") {
      const what = evaluated(t, p, false);
      if (what !== undefined) return what.reason;
    }
  }
  return undefined;
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
    // A lambda at the head too, `value({.[x;();:;1]};`a)` (#2195): read
    // applied to the rest, with them in place of its parameters.
    if (all.length < 2 || he - hs < 1 || !["name", "sym", "op", "open"].includes(t[hs].kind)) {
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
/// Whether a cast `$` with `left` on its left may give a string: to char,
/// `` `char$ ``, `"c"$`, or a type not written, `` k).$x ``, `x$y`; not to a
/// symbol, `` `$x ``, an enumeration, `` `sym$x ``, or a number, `"j"$x`.
function castsToString(left: Token | undefined): boolean {
  if (left === undefined || left.kind === "op" || left.kind === "open") return true;
  if (left.kind === "sym") return left.text === "`char";
  if (left.kind === "str") return ['"c"', '"C"', '"*"'].includes(left.text);
  if (left.kind === "num") return /^10h?$/.test(left.text);
  return true;
}

/// What makes a string of what may not be one.
const STRINGY = new Set(["string", "ssr", "trim", "ltrim", "rtrim", "lower", "upper", "read0", "read1", ".Q.s", ".Q.s1", ".j.j"]);

/// Where the argument of what ends at `t[last]` ends: at the first `;` or
/// close outside the brackets it opens.
function argumentEnd(t: Token[], last: number): number {
  let depth = 0;
  let p = last + 1;
  for (; p < t.length; p++) {
    if (t[p].kind === "open") depth++;
    else if (t[p].kind === "close" && depth-- === 0) break;
    else if (depth === 0 && t[p].text === ";") break;
  }
  scanned(p - last);
  return p;
}

/// How many brackets are open around `t[i]`, back to its lambda.
function around(t: Token[], i: number): number {
  let depth = 0;
  let p = i - 1;
  for (let inner = 0; p >= 0; p--) {
    if (t[p].kind === "close") inner++;
    else if (t[p].kind === "open" && inner > 0) inner--;
    else if (t[p].kind === "open" && t[p].text === "{") break;
    else if (t[p].kind === "open") depth++;
  }
  scanned(i - p);
  return depth;
}

/// Where the expression `t[i]` is in starts: after the `;` before it outside
/// every bracket around it, or the start of its lambda or statement.
function expressionStart(t: Token[], i: number): number {
  let depth = around(t, i);
  let p = i - 1;
  for (; p >= 0; p--) {
    if (t[p].kind === "close") depth++;
    else if (t[p].kind === "open" && depth-- === 0) break;
    else if (depth === 0 && t[p].text === ";") break;
  }
  scanned(i - p);
  return p + 1;
}

/// Where the expression `t[i]` is in ends: at the next `;` outside every
/// bracket around it, or the end of the lambda or statement it is in.
function expressionEnd(t: Token[], i: number): number {
  let depth = around(t, i);
  let p = i + 1;
  for (; p < t.length; p++) {
    if (t[p].kind === "open") depth++;
    else if (t[p].kind === "close" && depth-- === 0) break;
    else if (depth === 0 && t[p].text === ";") break;
  }
  scanned(p - i);
  return p;
}

/// What the strings an evaluator ending at `t[last]` is applied to run, up
/// to `t[end]`: each is read as the code it is (#1776), so `value "count t"`
/// reads, as a gateway's string does. One that is built, `value "a",":1"`,
/// or reaches it through another function, `value raze("a";":1")`, is
/// taken for a change; so is `parse` of what is not a string, and in k
/// code, `k)."x"`, any string, which is k and not read here.
function strings(t: Token[], last: number, end: number, kCode: boolean): string | undefined {
  scanned(end - last);
  let passing = true;
  let parsed = false;
  let seen = false;
  let lambda = 0;
  // The brackets open, and whether each is a list or a call's arguments,
  // whose items a string made in is not what is evaluated: `eval(!;`t;..;`symbol$())`.
  const opaque: boolean[] = [];
  for (let p = last + 1; p < end; p++) {
    const k = t[p];
    if (k.kind === "open" && k.text === "{") lambda++;
    else if (k.kind === "close" && k.text === "}") lambda--;
    if (lambda > 0 || k.text === "}") continue;
    // (The evaluator's own brackets, `value[x]`, `value/[x]`, hold its argument.)
    const own = k.text === "[" && t.slice(last + 1, p).every((x) => x.kind === "op" && ["/", "\\", "'", ":"].includes(x.text));
    if (k.kind === "open") opaque.push(!own && (k.text === "[" || items(t, p).length > 1));
    else if (k.kind === "close") opaque.pop();
    const made = !opaque.includes(true);
    if (k.kind === "name") {
      parsed ||= k.text === "parse";
      passing &&= PASSING.has(unqualified(k.text));
      // A string made without a string written, `` value string`a:1 ``,
      // `` value .Q.s1 x `` (#2203).
      if (made && STRINGY.has(unqualified(k.text))) return "a string";
    } else if (k.kind === "num" && k.text === "-5" && t[p + 1]?.text === "!") {
      parsed = true;
      p++;
    } else if (made && k.kind === "num" && k.text === "-3" && t[p + 1]?.text === "!") {
      return "a string";
    } else if (made && k.kind === "op" && k.text === "$" && t[p + 1]?.text !== "[" && castsToString(t[p - 1])) {
      // A cast, `` `char$97 58 49 ``, `"c"$0x..`, `` k).$`a:1 `` (#2203).
      return "a string";
    } else if (k.kind === "op") {
      passing &&= PASSING_OPS.has(k.text);
    } else if (k.kind === "str") {
      seen = true;
      const whole = passing && (p + 1 >= end || t[p + 1].text === ";" || t[p + 1].kind === "close");
      // Read as `value` reads it, whole: a `/` or `\` line in it is not a
      // script's comment or end (#2274).
      if (!whole || kCode || writes([valued(qText(k.text))]).length > 0) {
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

/// The namespaces that hold a function of `CALLED`: `.q`, `.Q`, and `.h`,
/// whose `ht` writes files and `val` is `value` (#2272).
const ROOTS = new Set([".q", ".Q", ".h"]);

/// The function of `CALLED` picked out of `root`, one of `ROOTS`, at `t[at]`
/// by whatever names it in the expression after it - `` .q[enlist`set]0 ``,
/// `` .q`$"set" ``, `` (.q`set`get)0 ``, `` (get`.q)`set `` (#1765) - or
/// undefined: `` .q`count `` reads.
function picked(t: Token[], at: number, root: string): string | undefined {
  const end = expressionEnd(t, at);
  scanned(end - at);
  for (let p = at + 1; p < end; p++) {
    const name = t[p].kind === "sym" ? t[p].text.slice(1) : t[p].kind === "str" ? qText(t[p].text) : undefined;
    if (name !== undefined && CALLED.has(unqualified(`${root}.${name}`))) {
      return `${root}.${name}`;
    }
  }
  return undefined;
}

/// Whether one of `ROOTS` at `t[at]`, or `` `.q `` got with `get` or `value`,
/// is indexed by what the guard cannot read: not symbols or strings written
/// but a symbol made, `` .q[`$"se","t"] ``, a number, `((value .q) 71)`, or
/// another expression, `(.q (key .q) 71)` (#2206).
function pickedUnread(t: Token[], at: number): boolean {
  let end = at;
  // `(value .q) 71`, `` (get`.q)`$"x" ``: indexed after the parentheses.
  if ((t[at - 1]?.text === "value" || t[at - 1]?.text === "get") && t[at - 2]?.text === "(" && t[at + 1]?.text === ")") {
    end = at + 1;
  }
  const k = t[end + 1];
  if (k === undefined) return false;
  const range: [number, number] | undefined =
    k.kind === "open" && k.text === "["
      ? [end + 2, items(t, end + 1).at(-1)?.[1] ?? t.length]
      : k.kind === "op" && (k.text === "@" || k.text === ".")
        ? [end + 2, argumentEnd(t, end + 1)]
        : ["sym", "str", "num", "name"].includes(k.kind) || (k.kind === "open" && k.text === "(")
          ? [end + 1, argumentEnd(t, end)]
          : undefined;
  if (range === undefined || range[0] >= range[1] || (k.kind === "name" && INFIX.has(k.text))) return false;
  return !t.slice(range[0], range[1]).every((x) => x.kind === "sym" || x.kind === "str" || x.text === "enlist" || x.text === ";" || x.text === "(" || x.text === ")");
}

/// What `parse`, or `-5!`, at `t[at]` picks that writes, applied to `arg`:
/// of a writer's name, `parse"set"`, the writer itself - of an amend, `!`,
/// `?`, an internal function or a file verb too - and of a string it cannot
/// read, whatever it gives where that is applied, `(parse x)[`a;1]` (#2205).
function parsedWriter(t: Token[], at: number, arg: [number, number] | undefined): string | undefined {
  if (arg === undefined) return undefined;
  const [a, b] = unwrapped(t, arg[0], arg[1]);
  if (b - a === 1 && t[a].kind === "str") {
    const text = qText(t[a].text).trim();
    const writer = CALLED.has(unqualified(text)) || ["@", ".", "?", "!", "0:", "1:", "2:"].includes(text) || /^-\d+[ihj]?!$/.test(text) || GATEWAY_EXEC.test(text) || /^\.(p|pykx)(\.|$)/.test(text);
    return writer ? `gets ${text} with parse` : undefined;
  }
  // Not a string written, and what it gives applied: `(parse x)[`a;1]`.
  let s = at;
  while (t[s - 1]?.text === "(" && t[s - 1].kind === "open") s--;
  const close = s < at ? (items(t, s).at(-1)?.[1] ?? -1) : -1;
  const after = t[close + 1];
  return close >= 0 && after !== undefined && (after.kind === "open" || ["sym", "str", "num", "name"].includes(after.kind) || after.text === "@" || after.text === ".")
    ? "applies what parse gives, which the guard cannot read"
    : undefined;
}

/// What a lambda's parameter is given in place of an argument that is a
/// name, or not written, which could name a global or a file:
/// `` {.[x;();:;1]} v `` amends whatever `v` names.
const WITNESSES = ["(`g)", "(`:g)"];
/// The most items of an iterated argument a lambda is read again with.
const ITEMS = 8;
/// The names after a lambda that apply it to each item of what follows.
const ITERATORS = new Set(["each", "peach", "over", "scan", "prior"]);
/// How deep `writes` is called in itself, how many lambdas it has read
/// again with their parameters given, and how many tokens it has read, in
/// the call `writes` was given from outside: past `DEPTH`, `REREADS` or
/// `WORK` the code is too much to read, and is asked about (#2210), as it is
/// when reading it throws (#2211). The bounds keep a read well under 100 ms.
let nesting = 0;
let rereads = 0;
let work = 0;
/// Whether a bound was passed, in the reading under way.
let exhausted = false;
/// Whether a lambda is being read with a witness for an argument.
let guessing = false;
const DEPTH = 24;
const REREADS = 10_000;
const WORK = 1_500_000;
/// What a text gives when it is too much to read, or reading it fails.
const TOO_MUCH = "is too long or too deeply nested for the guard to read";
/// What `writes` found in a text read again, by the text, for the call
/// `writes` was given from outside only: kept from one call to the next, a
/// text read once within the bounds and once past them gave two answers
/// for the same code (#2190). Within one call it is what reading it again
/// would give, so the answer is a function of the code alone.
const reread = new Map<string, string[]>();
/// The same for a lambda read with what it is given, by the statement it is
/// in, the lambda and what it is given (`throughParameters`).
const readings_ = new Map<string, Map<string, string[]>>();

/// Counts `n` tokens looked at again, a fourth of one read for the first time.
function scanned(n: number): void {
  work += n / 4;
}

/// Whether reading on would pass a bound; marks the reading so when it does.
function overBudget(): boolean {
  exhausted ||= nesting > DEPTH || rereads > REREADS || work > WORK;
  return exhausted;
}

function rereadOf(code: string): string[] {
  // What a text gives depends on whether it is read guessing.
  const text = `${guessing ? "?" : "="}${code}`;
  const known = reread.get(text);
  if (known !== undefined) {
    return known;
  }
  if (overBudget()) {
    return [TOO_MUCH];
  }
  rereads++;
  const found = writes(code);
  reread.set(text, found);
  return found;
}

/// The items of the argument `t[from]` to `t[to]` a lambda is applied to
/// each of: the symbols of `` `a`b ``, the items of `(x;y)`, or none.
function itemsOf(t: Token[], from: number, to: number): string[] {
  if (to - from > 1 && t.slice(from, to).every((k) => k.kind === "sym")) {
    return t.slice(from, to).map((k) => k.text);
  }
  // One item, `` enlist`a `` (#2201).
  if (to - from > 1 && t[from].kind === "name" && t[from].text === "enlist") {
    return [joined(t, from + 1, to)];
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
function throughParameters(t: Token[], all: Token[], statement: string, closes: number[], open: number, found: Set<string>): void {
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
    // `.` applies it to the items of a list: `(x;y)`, `enlist x`, `` `a`b `` (#2196).
    args = after.text === "@" ? [arg] : (listed(t, arg[0], arg[1]) ?? []);
  } else if (after !== undefined && (["str", "sym", "num", "name"].includes(after.kind) || after.kind === "open")) {
    args = [[q, argumentEnd(t, q - 1)]];
  } else if (before?.kind === "open" && before.text === "[" && (t[s - 2]?.text === "." || t[s - 2]?.text === "@") && t[s - 2].kind === "op") {
    // Applied by `.[f;(x;y)]` or `@[f;x]`, a trap among them.
    const all = items(t, s - 1);
    const arg = all[1];
    if (arg !== undefined && arg[0] < arg[1]) {
      args = t[s - 2].text === "@" ? [arg] : (listed(t, arg[0], arg[1]) ?? []);
    }
  } else if (before?.text === ":" && t[s - 2]?.kind === "name" && !iterated && (after === undefined || after.text === ";" || after.kind === "close")) {
    // Assigned to a local of the lambda around it, and applied there later:
    // `{f:{.[x;();:;1]}; f`a}` (#2200). With what it is given there, or not
    // seen applied, it reads.
    const local = t[s - 2].text;
    let outer = s - 2;
    for (let depth = 0; outer >= 0; outer--) {
      if (t[outer].kind === "close") depth++;
      else if (t[outer].kind === "open" && depth-- === 0) break;
    }
    scanned(s - outer);
    if (outer < 0 || t[outer].text !== "{" || closes[outer] === undefined || closes[outer] < 0) {
      return;
    }
    let use = -1;
    for (let p = e + 1; p < closes[outer] && use < 0; p++) {
      if (t[p].kind === "name" && t[p].text === local && t[p + 1] !== undefined && t[p + 1].text !== ":" && t[p + 1].text !== ";" && t[p + 1].kind !== "close") use = p;
    }
    scanned(closes[outer] - e);
    if (use < 0) {
      return;
    }
    if (t[use + 1].kind === "open" && t[use + 1].text === "[") {
      args = items(t, use + 1).map(([a, b]) => (a === b ? undefined : [a, b]));
    } else {
      const arg = argumentOf(t, use);
      args = arg === undefined ? [] : [arg];
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
  if (overBudget()) {
    return;
  }
  // The lambda's text with `given` in place of its parameters, which it then
  // no longer takes: the statement's text between where they stand.
  const from = t[open].n;
  const to = t[close].n;
  const list = named ? (t[listEnd]?.n ?? from) : from;
  const bodyStart = all[list].pos + all[list].text.length;
  const uses: Token[] = [];
  for (let p = list + 1, nested = 0; p < to; p++) {
    const k = all[p];
    if (k.kind === "open" && k.text === "{") nested++;
    else if (k.kind === "close" && k.text === "}") nested--;
    else if (nested === 0 && k.kind === "name" && params.includes(k.text)) uses.push(k);
  }
  const text = (given: Map<string, string>): string => {
    let out = given.size > 0 || named ? `{[${params.filter((p) => !given.has(p)).join(";")}]` : "{";
    let at = bodyStart;
    for (const k of uses) {
      const value = given.get(k.text);
      if (value !== undefined) {
        out += statement.slice(at, k.pos) + value;
        at = k.pos + k.text.length;
      }
    }
    return out + statement.slice(at, t[close].pos + 1);
  };
  // What a reading gives, by the statement, the lambda and what it is
  // given, so the text is not made again for one read already.
  const readOf = (given: Map<string, string>): string[] => {
    let byStatement = readings_.get(statement);
    if (byStatement === undefined) {
      byStatement = new Map();
      readings_.set(statement, byStatement);
    }
    const key = `${guessing ? "?" : "="}${open}\u0000${[...given].flat().join("\u0000")}`;
    const known = byStatement.get(key);
    if (known !== undefined) {
      return known;
    }
    const found = rereadOf(text(given));
    byStatement.set(key, found);
    return found;
  };
  const base = readOf(new Map());
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
  // Not again inside a reading that guesses already: one guess deep.
  if (held.some((h) => h) && !guessing) {
    for (const witness of WITNESSES) {
      readings.push([new Map(params.flatMap((p, n): [string, string][] => (held[n] ? [[p, witness]] : written[n] === undefined ? [] : [[p, written[n]]]))), true]);
    }
  }
  for (const [given, guessed] of readings) {
    const was = guessing;
    guessing ||= guessed;
    const read = readOf(given);
    guessing = was;
    for (const reason of read) {
      // (Too much to read is said once, by `writes`.)
      if (!base.includes(reason) && reason !== TOO_MUCH) {
        found.add(guessed ? "applies a lambda that may change the process through what it is given" : reason);
      }
    }
  }
}

/// The operators that change the process given the right arguments, read
/// as a call when they are passed as a value: `?`, which extends an
/// enumeration, the amends `@` and `.`, and `!`, whose `-11!` and `-19!`
/// replay a log and write a file (#2041).
const VALUES = new Set(["?", "@", ".", "!"]);

/// The items of the list `t[from]` to `t[to]` an operator is applied to by
/// `.`, `(x;y)` or `enlist x`; undefined when they are not written.
function listed(t: Token[], from: number, to: number): [number, number][] | undefined {
  // A list of symbols, `` `sym`x ``, also in parentheses, is as many items (#2189).
  const [a, b] = unwrapped(t, from, to);
  if (b - a > 1 && t.slice(a, b).every((k) => k.kind === "sym")) {
    return Array.from({ length: b - a }, (_, n): [number, number] => [a + n, a + n + 1]);
  }
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
      // Projected, `` (?)[`sym] ``, `` (!)[-11;] ``, and applied after:
      // `` (?)[`sym] `x ``, `` (?)[`sym]@`x `` (#2188).
      const close = args[args.length - 1][1];
      const more = t[close + 1];
      const later: [number, number][] | undefined =
        more?.kind === "open" && more.text === "["
          ? items(t, close + 1)
          : more?.kind === "op" && (more.text === "@" || more.text === ".") && argumentEnd(t, close + 1) > close + 2
            ? more.text === "@"
              ? [[close + 2, argumentEnd(t, close + 1)]]
              : listed(t, close + 2, argumentEnd(t, close + 1))
            : more !== undefined && (["str", "sym", "num", "name"].includes(more.kind) || (more.kind === "open" && more.text !== "{"))
              ? [[close + 1, argumentEnd(t, close)]]
              : undefined;
      const takes = op === "?" || op === "!" ? 2 : 3;
      if (later !== undefined && (args.length < takes || args.some(([a, b]) => a === b))) {
        const filled = args.map((arg): [number, number] => (arg[0] === arg[1] && later.length > 0 ? (later.shift() as [number, number]) : arg));
        args = [...filled, ...later];
      }
    } else if (after?.kind === "op" && (after.text === "." || after.text === "@") && argumentEnd(t, q) > q + 1) {
      args = after.text === "@" ? [[q + 1, argumentEnd(t, q)]] : listed(t, q + 1, argumentEnd(t, q));
    }
  }
  if (args === undefined || args.length === 0 || args.some(([a, b]) => a === b)) {
    return [];
  }
  const call = (texts: string[]): string => (texts.length === 2 ? `(${texts[0]})${op}(${texts[1]})` : `${op}[${texts.join(";")}]`);
  // An argument in parentheses already is written as it is: `(-11)!(-1;f)`.
  const own = ([a, b]: [number, number]): string => {
    const text = joined(t, a, b);
    return t[a]?.text === "(" && t[a].kind === "open" && items(t, a).at(-1)?.[1] === b - 1 && items(t, a).length > 1 ? text.slice(1, -1) : text;
  };
  const calls = [call(args.map((arg) => (args.length === 2 ? own(arg) : joined(t, arg[0], arg[1]))))];
  if (iterated) {
    calls.push(call(args.map(([a, b]) => itemsOf(t, a, b)[0] ?? joined(t, a, b))));
  }
  return calls;
}

/// What the TorQ gateway call named at `t[i]` - `.gw.syncexec`, or its
/// symbol - runs on its servers, added to `found`: each string in its
/// arguments read as the code it is (#909), and a query that is not
/// strings, or not written where the call is, taken for a change - a list
/// the servers evaluate, `(:;`a;1)`, a name, one built, `"a",":1"`, or
/// given later, `.gw.syncexec[;`rdb] "a:1"` (#2039). A lambda that only
/// reads may head a list of strings, as the extension's own wrap does,
/// `({last value each x};("a";"b"))`.
function gateway(t: Token[], i: number, found: Set<string>): void {
  const name = t[i].kind === "sym" ? t[i].text.slice(1) : t[i].text;
  const next = t[i + 1];
  // Its arguments: in brackets, or the list `.` applies it to.
  const args =
    next?.kind === "open" && next.text === "["
      ? items(t, i + 1)
      : next?.kind === "op" && next.text === "." && t[i + 2]?.text === "(" && t[i + 2].kind === "open"
        ? listed(t, i + 2, argumentEnd(t, i + 1))
        : undefined;
  const end = args !== undefined ? args[args.length - 1][1] : argumentEnd(t, i);
  // Whether a string in it writes, which is asked about already.
  let written = false;
  for (let j = i + 1; j < end; j++) {
    if (t[j].kind === "str") {
      for (const reason of writes([valued(qText(t[j].text))])) {
        found.add(`${reason} through ${name}`);
        written = true;
      }
    }
  }
  const query = args?.[0];
  let readable = false;
  if (query !== undefined && query[0] < query[1]) {
    readable = true;
    for (let j = query[0]; j < query[1] && readable; j++) {
      const k = t[j];
      if (k.kind === "open" && k.text === "{") {
        // A lambda that reads, at the head of a list: `({last value each x};..)`.
        let close = j;
        for (let depth = 0; close < query[1]; close++) {
          if (t[close].kind === "open") depth++;
          else if (t[close].kind === "close" && --depth === 0) break;
        }
        // Read applied to the rest of the list, as the servers apply it:
        // `({value raze x};("a";":1"))` evaluates "a:1" (#2186).
        const list = t[j - 1]?.text === "(" ? items(t, j - 1) : [];
        readable =
          t[j - 1]?.text === "(" &&
          t[close + 1]?.text === ";" &&
          (written || rereadOf(`${joined(t, j, close + 1)}[${list.slice(1).map(([a, b]) => joined(t, a, b)).join(";")}]`).length === 0) &&
          rereadOf(joined(t, j, close + 1)).length === 0;
        j = close;
      } else {
        readable = k.kind === "str" || k.text === ";" || k.text === "(" || k.text === ")" || k.text === "enlist";
      }
    }
  } else if (query === undefined && args === undefined) {
    // Named alone, not applied - `.gw.syncexec`, `` `.gw.syncexec `` - it reads.
    let s = i;
    let e = i;
    while (t[s - 1]?.text === "(" && t[e + 1]?.text === ")") {
      s--;
      e++;
    }
    const after = t[e + 1];
    // Not given to anything: `.[.gw.syncexec;("a:1";`rdb)]` applies it, and
    // `f[.gw.syncexec]`, `(.gw.syncexec;x)` may (#2187).
    let open = s - 1;
    for (let depth = 0; open >= 0; open--) {
      if (t[open].kind === "close") depth++;
      else if (t[open].kind === "open" && depth-- === 0) break;
    }
    scanned(s - open);
    const given = open >= 0 && t[open].text !== "{";
    if (given) {
      // What it is given with, read as its query is.
      const close = items(t, open).at(-1)?.[1] ?? t.length;
      for (let j = open + 1; j < close; j++) {
        if (t[j].kind === "str") {
          for (const reason of writes([valued(qText(t[j].text))])) found.add(`${reason} through ${name}`);
        }
      }
    }
    readable = !given && (after === undefined || after.text === ";" || after.kind === "close") && (t[s - 1] === undefined || t[s - 1].text === ";" || t[s - 1].text === ":" || t[s - 1].text === "{");
  }
  if (!readable) {
    found.add(`runs a query the guard cannot read through ${name}`);
  }
}

/// `statement` past its `q)` and `k)` prefixes, and the language of the
/// first other one, which runs the rest: `s)` SQL, `p)` Python (#2197, #2209).
function unprefixed(statement: string): { text: string; language?: string } {
  let text = statement.trimStart();
  for (let m = /^([A-Za-z])\)\s*/.exec(text); m !== null; m = /^([A-Za-z])\)\s*/.exec(text)) {
    text = text.slice(m[0].length);
    if (m[1] !== "q" && m[1] !== "k") {
      return { text, language: m[1] };
    }
  }
  return { text };
}

/// What `text`, in a language other than q and k, does that the guard asks
/// about: KDB-X SQL, `s)`, read as the SQL tab's guard reads it - a write
/// word in any case, `INSERT`, `drop`, a function that runs q, `qt(..)` -
/// and with a system command after the prefix, `s)\l f.q`, as that; any
/// other language, `p)` Python among them, is not read, so asked about.
function readLanguage(language: string, text: string, found: Set<string>): void {
  if (language !== "s") {
    found.add(`runs ${language === "p" ? "Python" : `${language}) code`} the guard cannot read`);
  } else if (/^[A-Za-z]\)/.test(text)) {
    // KDB-X runs `s)q)b[0]:1` as the q after the second prefix.
    readStatement(text, found);
  } else if (text.startsWith("\\")) {
    found.add(`runs the system command ${/^\\(\\|[A-Za-z_]*)/.exec(text)?.[0] ?? "\\"} through SQL`);
  } else if (sqlWrites(text).length > 0) {
    found.add(`runs SQL that changes data (${sqlWrites(text).join(", ")})`);
  }
}

/// What one statement does that the guard asks about, added to `found`.
function readStatement(statement: string, found: Set<string>): void {
  // A language prefix, `q)` or `k)`, as many as are written, `q)k)`, is
  // not what it runs: `k)\l f.q` loads the script (#2034).
  let { text, language } = unprefixed(statement);
  // `\t` and `\ts` time the expression after them, read in their place, as
  // many as are written.
  while (language === undefined && text.startsWith("\\")) {
    const command = /^\\(\\|[A-Za-z_]+)(?::\d+)?\s*([\s\S]*)$/.exec(text);
    const name = command?.[1] ?? "";
    const argument = (command?.[2] ?? "").trim();
    if (name === "t" && !text.startsWith("\\t:") && /^\d+$/.test(argument)) {
      found.add("sets the timer with \\t");
    } else if (name === "t" || name === "ts") {
      statement = argument;
      ({ text, language } = unprefixed(argument));
      continue;
    } else if (!(argument === "" && READS_BARE.has(name)) && !(name === "w" && /^[01]$/.test(argument))) {
      // (`\w 0` and `\w 1` report the symbols; another number sets the limit.)
      found.add(`runs the system command \\${name}`);
    }
    return;
  }
  if (language !== undefined) {
    readLanguage(language, text, found);
    return;
  }
  // The lambdas read again count by statement: a long script of reads is
  // not asked about for its length.
  if (nesting === 1) {
    rereads = 0;
  }
  const all = tokens(statement);
  work += all.length;
  if (overBudget()) {
    return;
  }
  // `a::` is a global assignment, `a: :` is not one.
  const touching = (a: Token | undefined, b: Token | undefined): boolean => a !== undefined && b !== undefined && b.n === a.n + 1;
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
  // The locals of each that hold a symbol, `heldLocals`.
  const held: Set<string>[] = [];
  // Between `select`, `exec`, `update` or `delete` and its `from`, a name
  // before `:` names a column. A stack, so a query nested in a column's
  // expression closes only itself: `` update c:(exec max a from s) from `t ``.
  const qsql: string[] = [];
  for (let i = 0; i < t.length && !overBudget(); i++) {
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
        held.push(heldLocals(t, i, closes[i], touching));
        throughParameters(t, all, statement, closes, i, found);
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
        // Past the parentheses the projection is in, `` (.[;();:;1]) `a ``,
        // and what applies it, `each`, an adverb, `@` or `.` (#2038).
        let close = args.length > 0 ? args[args.length - 1][1] : -1;
        for (let wraps = 0; t[i - 2 - wraps]?.text === "(" && t[close + 1]?.text === ")"; wraps++) close++;
        let applied = close + 1;
        while (t[applied]?.kind === "op" && ["'", "/", "\\", ":"].includes(t[applied].text)) applied++;
        if (t[applied]?.kind === "name" && ITERATORS.has(t[applied].text)) applied++;
        const iterated = applied > close + 1;
        if ((t[applied]?.text === "@" || t[applied]?.text === ".") && t[applied].kind === "op") applied++;
        if (t[applied]?.text === "enlist" && t[applied - 1]?.text === ".") applied++;
        const target =
          args[0]?.[0] !== args[0]?.[1]
            ? // The symbol alone, not indexed: `` @[(`t)[0];..] `` is a value.
              t.slice(args[0][0], args[0][1]).filter((k) => k.text !== "(" && k.text !== ")").length === 1
              ? symbolAt(t, i + 1)
              : undefined
            : (t[applied]?.text === "[" || (t[applied]?.text === "(" && t[applied - 1]?.text === ".")) && t[applied].kind === "open"
              ? symbolAt(t, applied + 1)
              : iterated && t[applied]?.kind === "sym"
                ? t[applied].text
                : symbolAt(t, applied);
        // Three is an amend too, with a unary, `` @[`t;`c;{x*2}] ``: on a
        // symbol it is never a trap (#1763). `!` takes four.
        if (target !== undefined && target.length > 1 && args.length >= minimum(amend)) {
          found.add(amend === "!" ? `updates or deletes from ${target} in place with !` : `amends ${target} in place`);
        } else if (args.length >= minimum(amend)) {
          // A target computed, `` @[first`b;0;+;1] ``, `` .[hsym`f;();:;1] ``,
          // or held by a local, may be by name too (#2198-#2201).
          const at = t[applied];
          const range =
            args[0][0] !== args[0][1]
              ? args[0]
              : at?.kind === "open" && at.text === "["
                ? items(t, applied)[0]
                : at?.kind === "open" && at.text === "(" && t[applied - 1]?.text === "."
                  ? listed(t, applied, argumentEnd(t, applied - 1))?.[0]
                  : at !== undefined && (["str", "sym", "num", "name"].includes(at.kind) || at.kind === "open")
                    ? [applied, argumentEnd(t, applied - 1)]
                    : undefined;
          if (range !== undefined && (iterated ? itemSymbolic : symbolic)(t, range[0], range[1], held.at(-1))) {
            found.add(`${amend === "!" ? "updates or deletes from" : "amends"} what ${shown(t, range[0], range[1])} names in place`);
          }
        }
      }
      continue;
    }
    if (k.kind === "close") {
      const kind = stack.pop();
      lambdas -= kind === "lambda" ? 1 : 0;
      if (kind === "lambda") {
        locals.pop();
        held.pop();
      }
      continue;
    }
    if (k.kind === "name") {
      if (["select", "exec", "update", "delete"].includes(k.text)) {
        qsql.push(k.text);
        continue;
      }
      if (k.text === "from" && qsql.length > 0) {
        const query = qsql.pop();
        if (query === "update" || query === "delete") {
          // The table, to its `where`: a symbol, `` from `t ``, `` from (`t) ``,
          // or computed, `` from first`t `` (#2198).
          let end = i + 1;
          for (let depth = 0; end < t.length; end++) {
            if (t[end].kind === "open") depth++;
            else if (t[end].kind === "close" && depth-- === 0) break;
            else if (depth === 0 && (t[end].text === ";" || (t[end].kind === "name" && t[end].text === "where"))) break;
          }
          scanned(end - i);
          const [a, b] = unwrapped(t, i + 1, end);
          const table = b - a === 1 && t[a].kind === "sym" ? t[a].text : undefined;
          if (table !== undefined) {
            found.add(table === "`." ? "deletes from the root namespace" : `${query === "update" ? "updates" : "deletes from"} ${table} in place`);
          } else if (symbolic(t, i + 1, end, held.at(-1))) {
            found.add(`${query === "update" ? "updates" : "deletes from"} what ${shown(t, i + 1, end)} names in place`);
          }
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
      if (ROOTS.has(k.text) && index !== undefined) {
        const name = `${k.text}.${index.text.slice(1)}`;
        if (CALLED.has(unqualified(name))) {
          found.add(`calls ${name}`);
          continue;
        }
      }
      const name = ROOTS.has(k.text) ? picked(t, i, k.text) : undefined;
      if (name !== undefined) {
        found.add(`calls ${name}`);
        continue;
      }
      // Picked by what it cannot read, `` .q[`$"se","t"] ``, `((value .q) 71)` (#2206).
      if (ROOTS.has(k.text) && pickedUnread(t, i)) {
        found.add(`calls a function picked from ${k.text} by what the guard cannot read`);
        continue;
      }
      // `parse` of a writer's name gives the writer: `(parse"set")[`a;1]` (#2205).
      if (unqualified(k.text) === "parse") {
        const what = parsedWriter(t, i, argumentOf(t, i));
        if (what !== undefined) {
          found.add(what);
          continue;
        }
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
        // The table computed, `` `a xdesc first`t ``, `` () xkey `$"kt" `` (#2198):
        // the right argument, the second in brackets, or what a projection
        // on the columns is applied to.
        const after = (close: number): [number, number] | undefined =>
          t[close + 1]?.text === "[" && t[close + 1].kind === "open"
            ? items(t, close + 1)[0]
            : t[close + 1]?.kind === "op" && t[close + 1].text === "@"
              ? [close + 2, argumentEnd(t, close + 1)]
              : t[close + 1] !== undefined && t[close + 1].kind !== "op" && t[close + 1].kind !== "close" && t[close + 1].text !== ";"
                ? [close + 1, argumentEnd(t, close)]
                : undefined;
        const bracketed = next?.text === "[" && next.kind === "open" ? items(t, i + 1) : undefined;
        const computed =
          bracketed !== undefined
            ? bracketed.length >= 2 && bracketed[1][0] < bracketed[1][1]
              ? bracketed[1]
              : after(bracketed[bracketed.length - 1][1])
            : t[i - 1]?.kind === "sym" && t[i - 2]?.text === "(" && next?.text === ")"
              ? after(i + 1)
              : t[i - 1] !== undefined && ["sym", "name", "num", "str", "close"].includes(t[i - 1].kind) && next !== undefined && next.kind !== "op" && next.kind !== "close" && next.text !== ";"
                ? [i + 1, argumentEnd(t, i)]
                : undefined;
        if (table !== undefined && table.length > 1) {
          found.add(`${unqualified(k.text) === "xkey" ? "keys" : "sorts"} ${table} in place with ${k.text}`);
        } else if (computed !== undefined && symbolic(t, computed[0], computed[1], held.at(-1))) {
          found.add(`${unqualified(k.text) === "xkey" ? "keys" : "sorts"} what ${shown(t, computed[0], computed[1])} names in place with ${k.text}`);
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
      // embedPy and PyKX run Python, which the guard does not read: `.p.e`,
      // `.p.qeval`, `.p.import`, `.pykx.pyexec` (#2197).
      if (/^\.(p|pykx)(\.|$)/.test(k.text)) {
        found.add(`runs Python with ${k.text}`);
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
        } else if (handle === undefined) {
          // Made some way it cannot read, `` hopen hsym(`f) ``,
          // `` hopen hsym first`f ``, `` hopen `$":",string`f `` (#2207).
          const arg = argumentOf(t, i);
          if (arg !== undefined && madeHandle(t, arg[0], arg[1], held.at(-1))) {
            found.add(`opens a handle the guard cannot read with ${k.text}`);
          }
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
        const byValue = unqualified(k.text) !== "eval" && unqualified(k.text) !== "reval";
        const what = evaluates(t, i + (wrapped || trapped ? 1 : 0), byValue, false, applied ? undefined : expressionEnd(t, i)) ?? (applied && !wrapped ? undefined : treesAround(t, i, byValue));
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
        gateway(t, i, found);
        continue;
      }
      // An assignment: the name, an index, an operator, then `:`.
      let j = i + 1;
      const indexed = t[j]?.text === "[" && t[j]?.kind === "open";
      if (indexed) {
        j = (closes[j] < 0 ? t.length : closes[j]) + 1;
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
    // In q too, `.` with nothing on its left applied to a list or a string
    // is `value`: `.({.[x;();:;1]};`a)` (#2195).
    const qDot =
      !kCode &&
      k.kind === "op" &&
      k.text === "." &&
      (i === code || [";", "[", "{", ":"].includes(t[i - 1]?.text ?? "")) &&
      (next?.kind === "str" || (next?.kind === "open" && next.text === "("));
    if (qDot) {
      const what = evaluates(t, i, true);
      if (what !== undefined) {
        found.add(`evaluates ${what.reason} with .`);
        i = what.at;
        continue;
      }
    }
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
    // In k, `~`, `<` and `>` with nothing on their left are `hdel`, `hopen`
    // and `hclose` given a file or a handle (#2275): `` k)~`:f ``, `k)>.z.w`,
    // also in parentheses, `` k)(~)`:f ``, and as `~:`. On a list written
    // they are `not`, `iasc` and `idesc`; on a name, a file or a handle may
    // be what it holds.
    if (kCode && i >= code && k.kind === "op" && ["~", "<", ">"].includes(k.text)) {
      const prev = t[i - 1];
      const wrapped = prev?.text === "(" && next?.text === ")";
      const monadic = i === code || prev === undefined || prev.kind === "open" || prev.text === ";" || (prev.kind === "op" && prev.text !== ")");
      if (monadic) {
        const start = (next?.text === ":" && touching(k, next)) || wrapped ? i + 2 : i + 1;
        const operand = t.slice(start, argumentEnd(t, start - 1));
        const list = (operand.length > 1 && operand.every((x) => x.kind === "num")) || (operand.length === 1 && operand[0].kind === "str");
        const handle =
          k.text === ">"
            ? operand.length > 0 && !list
            : operand.some((x, n) => (x.kind === "sym" && x.text.startsWith("`:")) || x.kind === "name" || (x.kind === "op" && x.text === "$") || (x.text === "-1" && operand[n + 1]?.text === "!"));
        if (handle) {
          found.add(k.text === "~" ? "deletes a file with k's ~" : k.text === "<" ? "opens a file with k's <" : "closes a handle with k's >");
          continue;
        }
      }
    }
    // An assignment written as a call, `:[a;77]`, `::[a;77]`, `+:[a;1]`, and
    // in parentheses, `(:)[a;77]`, `(+:)[a;1]` (#2264): its first argument
    // is assigned by the rules of `a:77` - global at the top level, with
    // `::`, to a dotted name, or compound or indexed to a name that is not a
    // local of the lambda it is in.
    // (After an iterator, `':[f;x]`, `/:[f;x]`, it is the iterator's.)
    if (k.kind === "op" && k.text === ":" && (next?.text !== ":" || !touching(k, next)) && !(t[i - 1]?.kind === "op" && ["'", "/", "\\"].includes(t[i - 1].text) && touching(t[i - 1], k))) {
      const wrapped = next?.text === ")" && next.kind === "close";
      const bracket = t[i + (wrapped ? 2 : 1)];
      // Where the operator starts: `::` and `+:` are one, `0:` a file verb.
      const start = i > code && t[i - 1].kind === "op" && touching(t[i - 1], k) && (t[i - 1].text === ":" || OPERATORS.has(t[i - 1].text)) ? i - 1 : i;
      const before = t[start - 1];
      // After a lambda's parameters, `{[x]:[b 0;1]}`, it starts the body.
      const params = before?.text === "]" && t.findIndex((x, n) => closes[n] === start - 1 && x.text === "[" && t[n - 1]?.text === "{") >= 0;
      const opened = start === code || before === undefined || !touching(before, t[start]) || before.kind === "open" || before.kind === "op" || before.text === ";" || params;
      if (bracket?.kind === "open" && bracket.text === "[" && opened && (!wrapped || before?.text === "(")) {
        const global = t[start].text === ":" && start < i;
        const compound = start < i && !global;
        const first = items(t, i + (wrapped ? 2 : 1))[0];
        const [a, b] = first === undefined ? [0, 0] : unwrapped(t, first[0], first[1]);
        // A name, indexed or not, `b 0`, `d[`a]`, or names, `(a;s)`.
        const names: string[] = [];
        if (b > a && t[a].kind === "name") names.push(t[a].text);
        else if (b > a && first !== undefined && t[first[0]].text === "(") destructured(t, first[0], names);
        const indexed = b - a > 1 && t[a].kind === "name";
        for (const target of names) {
          const local = locals.at(-1)?.has(target) ?? false;
          if (lambdas === 0 || global || target.includes(".") || ((compound || indexed) && !local)) {
            found.add(`assigns ${target}`);
          }
        }
        if (names.length > 0) {
          continue;
        }
      }
    }
    // `.q` by its symbol, `` (get`.q)`set ``, likewise.
    const name = k.kind === "sym" && ROOTS.has(k.text.slice(1)) ? picked(t, i, k.text.slice(1)) : undefined;
    if (name !== undefined) {
      found.add(`calls ${name}`);
      continue;
    }
    if (k.kind === "sym" && ROOTS.has(k.text.slice(1)) && pickedUnread(t, i)) {
      found.add(`calls a function picked from ${k.text.slice(1)} by what the guard cannot read`);
      continue;
    }
    // `-5!` is `parse`: `` (-5!"hopen")`:f `` (#2205).
    if (k.kind === "num" && k.text.replace(/[ihj]$/, "") === "-5" && next?.text === "!" && t[i - 1]?.kind !== "num") {
      const end = argumentEnd(t, i + 1);
      const what = parsedWriter(t, i, end > i + 2 ? [i + 2, end] : undefined);
      if (what !== undefined) {
        found.add(what);
        continue;
      }
    }
    // A gateway called by its symbol: `` `.gw.syncexec . ("a:1";`rdb) `` (#2039).
    if (k.kind === "sym" && GATEWAY_EXEC.test(k.text.slice(1))) {
      gateway(t, i, found);
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
      // The target computed (#2198).
      const first = t[j]?.text === "(" && t[j].kind === "open" ? items(t, j) : [];
      if (first.length >= minimum(k.text) && symbolic(t, first[0][0], first[0][1], held.at(-1))) {
        found.add(`${k.text === "!" ? "updates or deletes from" : "amends"} what ${shown(t, first[0][0], first[0][1])} names in place`);
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
      const sym = left ?? (applied?.kind === "sym" ? applied.text : undefined) ?? (args.length === 2 ? symbolAt(t, args[0][0]) : undefined);
      if (sym !== undefined && sym.length > 1 && (args.length !== 2 || unwrapped(t, args[0][0], args[0][1])[1] - unwrapped(t, args[0][0], args[0][1])[0] === 1)) {
        found.add(`extends the enumeration ${sym} with ?`);
        continue;
      }
      // Or computed, `` (first`sym)?`x ``, `` ?[(`sym;`x)0;`y] ``, or held by a
      // local (#2198, #2202).
      const operand = args.length === 2 ? args[0] : leftArgument(t, i);
      const bare = operand === undefined ? undefined : unwrapped(t, operand[0], operand[1]);
      if (operand !== undefined && bare !== undefined && operand[0] < operand[1] && !(bare[1] - bare[0] === 1 && t[bare[0]].kind === "sym") && t[operand[0] - 1]?.kind !== "sym" && symbolic(t, operand[0], operand[1], held.at(-1))) {
        found.add(`extends the enumeration ${shown(t, operand[0], operand[1])} names with ?`);
        continue;
      }
    }
    // Where the `!` of an internal function `-N!` is, spaced or with the
    // number in parentheses: `-19 !x`, `(-19)!x`. Not after a number, where
    // it ends a list: `1 -19!x`.
    let bang =
      k.kind !== "num" || !k.text.startsWith("-") || t[i - 1]?.kind === "num"
        ? -1
        : next?.text === "!"
          ? i + 1
          : t[i - 1]?.text === "(" && next?.text === ")" && t[i + 2]?.text === "!"
            ? i + 2
            : -1;
    // The number, with a type, `-11j`, as without (#2208).
    let fn = bang > 0 ? k.text.replace(/^(-\d+)[ihj]$/, "$1") : "";
    // Or computed, `(neg 11)!`, `(0-11)!`, `neg[6]!`: what it comes to, or,
    // where it cannot be read, an internal function it cannot read (#2208).
    if (k.kind === "op" && k.text === "!" && (t[i - 1]?.text === ")" || t[i - 1]?.text === "]") && t[i - 1].kind === "close") {
      const left = t[i - 1].text === ")" ? leftArgument(t, i) : undefined;
      let group: [number, number] | undefined = left !== undefined && left[0] < left[1] ? [left[0], i] : undefined;
      if (t[i - 1].text === "]") {
        let open = i - 1;
        for (let depth = 0; open >= 0; open--) {
          if (t[open].kind === "close") depth++;
          else if (t[open].kind === "open" && --depth === 0) break;
        }
        scanned(i - open);
        group = open > 0 && t[open - 1].kind === "name" ? [open - 1, i] : undefined;
      }
      const [a, b] = group === undefined ? [0, 0] : unwrapped(t, group[0], group[1]);
      const tokensIn = group === undefined ? [] : t.slice(a, b);
      if (group !== undefined && !(tokensIn.length === 1 && tokensIn[0].kind === "num") && tokensIn.every((x) => x.kind !== "sym" && x.kind !== "str")) {
        const value = constant(t, a, b);
        if (value !== undefined) {
          bang = i;
          fn = String(value);
        } else if (tokensIn.some((x) => x.text === "neg" || x.text === "-" || (x.kind === "num" && x.text.startsWith("-")))) {
          found.add("calls an internal function the guard cannot read with !");
          continue;
        }
      }
    }
    // `-6!` is `eval`, and `-24!` `reval` (#1774); passed as a value,
    // `(-6!)(:;`a;1)`, `(-6!;::)[0]`, it is read on the trees around it (#2266).
    if (bang > 0 && (fn === "-6" || fn === "-24")) {
      const passed = t[bang + 1] === undefined || t[bang + 1].text === ";" || (t[bang + 1].kind === "close" && t[bang + 1].text !== "}");
      const what = evaluates(t, bang, false) ?? (passed ? treesAround(t, bang, false) : undefined);
      if (what !== undefined) {
        found.add(`evaluates ${what.reason} with ${fn}!`);
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
      // A function's result too, `0 raze("a:";"1")`, `0 {x}"a:1"` (#2204) - not
      // a keyword between its arguments, `0 sublist x`.
      if (
        first?.kind === "str" ||
        first?.kind === "sym" ||
        (first?.kind === "open" && first.text !== "]") ||
        (first?.kind === "op" && ["@", "."].includes(first.text)) ||
        (first?.kind === "name" && !INFIX.has(first.text))
      ) {
        const what = evaluates(t, last, true);
        if (what !== undefined) {
          found.add(`evaluates ${what.reason} on handle 0`);
          i = what.at;
          continue;
        }
      }
      // An item of a list picked and applied, `(0;::)[0](@;`b;0;:;77)`:
      // read on the trees around it, as an evaluator passed as a value (#2266).
      if ((t[i - 1]?.text === "(" || t[i - 1]?.text === ";") && (next?.text === ";" || next?.text === ")")) {
        let close = i + 1;
        for (let depth = 0; close < t.length; close++) {
          if (t[close].kind === "open") depth++;
          else if (t[close].kind === "close" && depth-- === 0) break;
        }
        scanned(close - i);
        const what = t[close]?.text === ")" && t[close + 1]?.kind === "open" && t[close + 1].text === "[" ? treesAround(t, i, true) : undefined;
        if (what !== undefined) {
          found.add(`evaluates ${what.reason} on handle 0`);
          continue;
        }
      }
    }
    // `-11!` replays a log; `-11!(-1;..)` and `(-2;..)` only count and check it.
    if (bang > 0 && fn === "-11" && !(t[bang + 1]?.text === "(" && /^-[12]$/.test(t[bang + 2]?.text ?? ""))) {
      found.add("replays a log with -11!");
      continue;
    }
    // `-19!` compresses a file into another one.
    if (bang > 0 && fn === "-19") {
      found.add("writes a compressed file with -19!");
      continue;
    }
    // `-104!`, `.Q.Ls`, sets or clears a breakpoint in a function's code (#2276).
    if (bang > 0 && fn === "-104") {
      found.add("patches a function's code with -104!");
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
  if (nesting > 0) {
    return read(code);
  }
  rereads = 0;
  work = 0;
  exhausted = false;
  guessing = false;
  reread.clear();
  readings_.clear();
  try {
    const found = read(code);
    return exhausted ? [...new Set([...found, TOO_MUCH])] : found;
  } catch {
    // Too deep for the stack, or a defect: asked about, never let through.
    nesting = 0;
    return [TOO_MUCH];
  }
}

/// What `writes` finds in `code`, read within the bounds.
function read(code: GuardCode): string[] {
  nesting++;
  try {
    const found = new Set<string>();
    if (overBudget()) {
      return [];
    }
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

/// The question asked when `reval`, the guard's backstop (`readEnforce`),
/// refused code the guard read as read-only on the process `label`, with
/// q's error `refused`: whether to send it again as it is.
export function refusalQuestion(label: string, refused: string): string {
  return `Refused by the read-only evaluation of ${label}: '${refused}. Run it anyway?`;
}

/// Why such code was not run, to a caller that cannot ask: an agent, a
/// timer.
export function refusalReason(label: string, refused: string): string {
  return `Refused by the read-only evaluation of ${label}: '${refused}. The read-only guard read the code as read-only, and q refused it as a change (q-lint.processes.readOnlyGuard.enforce); nothing was changed.`;
}
