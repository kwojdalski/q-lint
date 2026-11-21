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
//   `name::` or a dotted `.ns.name:` inside a lambda, where q makes them
//   global. A column named in `select a:x from t` or `([] a:1 2)` is not
//   an assignment;
// - `update` or `delete` from a table named by a symbol (`` from `t ``),
//   which changes it in place;
// - `set`, `upsert`, `insert`, `hdel`, `exit`, `system`, `.Q.dpft`,
//   `.Q.dpfts`, `.Q.hdpf` and `.Q.en`, and `0:` or `1:` to a file handle
//   (`` `:f 0: ``), and `2:`;
// - `@[` or `.[` on a variable named by a symbol, with four arguments: an
//   amend in place (three is as often a trap, `.[`f;args;handler]`, and
//   is not taken for one);
// - `value` or `eval` applied to a string;
// - a system command (`\l`, `\cd x`, `\\`), except one that only reads a
//   setting (`\c`, `\d`, `\P` without an argument) and `\t` or `\ts`, whose
//   expression is read by these rules;
// - any of these in a string given to a TorQ gateway's `.gw.syncexec` or
//   `.gw.asyncexec`, which runs it on the gateway's servers (#909).
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
const WRITERS = new Set(["set", "upsert", "insert", "hdel", "exit", "system", ".Q.dpft", ".Q.dpfts", ".Q.hdpf", ".Q.en"]);
/// System commands that only read a setting when they are given no argument.
const READS_BARE = new Set([..."abBcCdefgoOpPsSTvwWz", "cd"]);

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

/// What one statement does that the guard asks about, added to `found`.
function readStatement(statement: string, found: Set<string>): void {
  const text = statement.trimStart();
  if (text.startsWith("\\")) {
    const command = /^\\(\\|[A-Za-z_]+)(?::\d+)?\s*([\s\S]*)$/.exec(text);
    const name = command?.[1] ?? "";
    const argument = (command?.[2] ?? "").trim();
    if (name === "t" || name === "ts") {
      readStatement(argument, found);
    } else if (!(argument === "" && READS_BARE.has(name))) {
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
  // What each open bracket is: a lambda, a table literal, or neither.
  const stack: ("lambda" | "table" | "other")[] = [];
  let lambdas = 0;
  let tables = 0;
  // Between `select`, `exec`, `update` or `delete` and its `from`, a name
  // before `:` names a column.
  let qsql: string | undefined;
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    const next = t[i + 1];
    if (k.kind === "open") {
      const kind = k.text === "{" ? "lambda" : k.text === "(" && next?.text === "[" ? "table" : "other";
      stack.push(kind);
      lambdas += kind === "lambda" ? 1 : 0;
      tables += kind === "table" ? 1 : 0;
      if (k.text === "[" && (t[i - 1]?.text === "@" || t[i - 1]?.text === ".") && t[i - 1]?.kind === "op" && next?.kind === "sym" && next.text.length > 1) {
        // Count the arguments at this depth.
        let depth = 0;
        let args = 1;
        for (let j = i + 1; j < t.length; j++) {
          if (t[j].kind === "open") depth++;
          else if (t[j].kind === "close") {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0 && t[j].text === ";") args++;
        }
        // Three is a trap as often as an amend: `.[`f;args;handler]`.
        if (args >= 4) {
          found.add(`amends ${next.text} in place`);
        }
      }
      continue;
    }
    if (k.kind === "close") {
      const kind = stack.pop();
      lambdas -= kind === "lambda" ? 1 : 0;
      tables -= kind === "table" ? 1 : 0;
      continue;
    }
    if (k.kind === "name") {
      if (["select", "exec", "update", "delete"].includes(k.text)) {
        qsql = k.text;
        continue;
      }
      if (k.text === "from" && qsql !== undefined) {
        if ((qsql === "update" || qsql === "delete") && next?.kind === "sym") {
          found.add(next.text === "`." ? "deletes from the root namespace" : `${qsql === "update" ? "updates" : "deletes from"} ${next.text} in place`);
        }
        qsql = undefined;
        continue;
      }
      if (WRITERS.has(k.text)) {
        found.add(`calls ${k.text}`);
        continue;
      }
      if ((k.text === "value" || k.text === "eval") && next?.kind === "str") {
        found.add(`evaluates a string with ${k.text}`);
        continue;
      }
      // A TorQ gateway runs the strings it is given on its servers (#909):
      // what they do is read as if they were sent directly.
      if (GATEWAY_EXEC.test(k.text) && next?.text === "[") {
        let depth = 0;
        for (let j = i + 1; j < t.length; j++) {
          if (t[j].kind === "open") depth++;
          else if (t[j].kind === "close" && --depth === 0) break;
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
      if (t[j]?.text === "[" && t[j]?.kind === "open") {
        let depth = 0;
        for (; j < t.length; j++) {
          if (t[j].kind === "open") depth++;
          else if (t[j].kind === "close" && --depth === 0) break;
        }
        j++;
      }
      if (t[j]?.kind === "op" && OPERATORS.has(t[j].text) && t[j + 1]?.text === ":" && touching(t[j], t[j + 1])) {
        j++;
      }
      if (t[j]?.text !== ":" || t[j]?.kind !== "op") {
        continue;
      }
      const global = t[j + 1]?.text === ":" && touching(t[j], t[j + 1]);
      const column = qsql !== undefined || tables > 0;
      if (column && !global) {
        continue;
      }
      if (lambdas === 0 || global || k.text.includes(".")) {
        found.add(`assigns ${k.text}`);
      }
      continue;
    }
    if (k.kind === "num" && (k.text === "0" || k.text === "1" || k.text === "2") && next?.text === ":" && touching(k, next)) {
      if (k.text === "2") {
        found.add("loads a shared object with 2:");
      } else if (t[i - 1]?.kind === "sym" && t[i - 1].text.startsWith("`:")) {
        found.add(`writes the file ${t[i - 1].text} with ${k.text}:`);
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
