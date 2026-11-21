// Toggle Parameter Cache (#892), as data: finding the lambda at the cursor
// and its parameters, and the one statement that caches them. No `vscode`
// import, so all of it is tested with node; `paramcachecontrol.ts` is the
// VS Code around it.
//
// The statement goes first in the lambda's body. When the lambda is called it
// keeps the call's arguments under `.qlint.cache.<id>` and sets each
// parameter as a global of the same name, so the body's lines can then be run
// on their own with the call's values:
//
//   f:{[a;b] a+b}   ->   f:{[a;b].qlint.cache.p1a2b3c:(a;b);`a`b set'.qlint.cache.p1a2b3c; a+b}
//   g:{x*2}         ->   g:{.qlint.cache.p4d5e6f:x;`x set .qlint.cache.p4d5e6f;x*2}
//
// The lambda is found by reading the text, not by asking the language
// server: the server answers no request for "the lambda at this position",
// and a scan by q's own script rules (those `statements.ts` cuts code by) is
// all the question needs. It never runs the code.

/// The command, for `package.json`'s manifest test.
export const PARAM_CACHE = {
  toggle: "q-lint.toggleParameterCache",
} as const;

/// The namespace q-lint owns for the cache: the statement keeps a call's
/// arguments here, under its id.
export const CACHE_NAMESPACE = ".qlint.cache";

/// A lambda in the text: its braces and its parameters.
export interface Lambda {
  /// Offsets of its `{` and its matching `}`.
  open: number;
  close: number;
  /// Where its body starts: after the `[...]` list, or after the `{`.
  bodyStart: number;
  /// The names in its `[...]` list; undefined when it has none, and its
  /// parameters are the `x`, `y` and `z` it reads.
  explicit: string[] | undefined;
  /// The lambdas directly inside it.
  children: Lambda[];
}

/// For each offset of `text`, whether q reads it as code: false inside a
/// string, a comment, a block comment, a system command line, and after a
/// lone `\` that ends the script.
export function codeMask(text: string): boolean[] {
  const mask: boolean[] = new Array(text.length).fill(false);
  let inBlock = false;
  let ended = false;
  let inString = false;
  let at = 0;
  while (at <= text.length && !ended) {
    const nl = text.indexOf("\n", at);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(at, end);
    const line = raw.replace(/\s+$/, "");
    if (inString) {
      // A string runs on until its closing quote, whatever the line holds.
    } else if (inBlock) {
      inBlock = line !== "\\";
      at = end + 1;
      continue;
    } else if (line === "/") {
      inBlock = true;
      at = end + 1;
      continue;
    } else if (line === "\\") {
      ended = true;
      break;
    } else if (line.startsWith("/") || line.startsWith("\\")) {
      at = end + 1;
      continue;
    }
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      const offset = at + i;
      if (inString) {
        mask[offset] = false;
        if (c === "\\") {
          i++;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      // `/` after a space or a tab, or at the start of a line, starts a
      // comment to the end of the line.
      if (c === "/" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
        break;
      }
      mask[offset] = true;
    }
    if (nl === -1) {
      break;
    }
    // The newline is code when the line was: it separates tokens.
    mask[nl] = !inString;
    at = nl + 1;
  }
  return mask;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/// Every lambda in `text`, outermost first, each with the lambdas inside it.
/// An unbalanced brace leaves its lambda out.
export function lambdas(text: string, mask: boolean[] = codeMask(text)): Lambda[] {
  const top: Lambda[] = [];
  const stack: { open: number; children: Lambda[] }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!mask[i]) {
      continue;
    }
    if (text[i] === "{") {
      stack.push({ open: i, children: [] });
    } else if (text[i] === "}" && stack.length > 0) {
      const { open, children } = stack.pop()!;
      const lambda: Lambda = { open, close: i, ...paramList(text, mask, open, i), children };
      (stack.length > 0 ? stack[stack.length - 1].children : top).push(lambda);
    }
  }
  return top;
}

/// The `[a;b]` after a lambda's `{` (q allows space before it), if it has
/// one.
function paramList(text: string, mask: boolean[], open: number, close: number): { bodyStart: number; explicit: string[] | undefined } {
  let i = open + 1;
  while (i < close && /\s/.test(text[i])) {
    i++;
  }
  if (text[i] === "[" && mask[i]) {
    const end = text.indexOf("]", i);
    if (end !== -1 && end < close) {
      const inside = text.slice(i + 1, end);
      const names = inside.trim() === "" ? [] : inside.split(";").map((n) => n.trim());
      if (names.every((n) => NAME.test(n))) {
        return { bodyStart: end + 1, explicit: names };
      }
    }
  }
  return { bodyStart: open + 1, explicit: undefined };
}

/// The innermost lambda that holds `offset` (from its `{` to its `}`); or,
/// when none does, the first lambda that opens later on the same line, so
/// the cursor at the start of `f:{[a] ...` finds `f`'s lambda.
export function lambdaAt(text: string, offset: number, all: Lambda[] = lambdas(text)): Lambda | undefined {
  let found: Lambda | undefined;
  let level = all;
  for (;;) {
    const inside = level.find((l) => l.open <= offset && offset <= l.close);
    if (inside === undefined) {
      break;
    }
    found = inside;
    level = inside.children;
  }
  if (found !== undefined) {
    return found;
  }
  const lineEnd = text.indexOf("\n", offset);
  const limit = lineEnd === -1 ? text.length : lineEnd;
  return all.find((l) => l.open >= offset && l.open < limit);
}

/// The offsets of `lambda`'s own body that are code: not its children's,
/// and not strings or comments.
function ownCode(lambda: Lambda, mask: boolean[]): (offset: number) => boolean {
  return (offset) =>
    mask[offset] === true &&
    offset >= lambda.bodyStart &&
    offset < lambda.close &&
    !lambda.children.some((c) => c.open <= offset && offset <= c.close);
}

/// The parameters of `lambda`: its `[...]` list, or `x`, `y` and `z` up to
/// the highest its own body reads, as q reads them - not in a string, a
/// comment, a symbol, a dotted name such as `.z.x` or a nested lambda.
export function parameters(text: string, lambda: Lambda, mask: boolean[] = codeMask(text)): string[] {
  if (lambda.explicit !== undefined) {
    return lambda.explicit;
  }
  const own = ownCode(lambda, mask);
  let highest = -1;
  let i = lambda.bodyStart;
  while (i < lambda.close) {
    if (!own(i)) {
      i++;
      continue;
    }
    const c = text[i];
    const run = (re: RegExp, from: number): number => {
      let j = from;
      while (j < lambda.close && own(j) && re.test(text[j])) {
        j++;
      }
      return j;
    };
    if (c === "`") {
      // A symbol; a file symbol (`:a/b) runs through its slashes.
      i = run(text[i + 1] === ":" ? /[A-Za-z0-9._:/]/ : /[A-Za-z0-9._:]/, i + 1);
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      // A number, with any type letter after it (0Nz is a null, not z). No
      // number holds a `_`: `1_x` is 1, drop, x.
      let j = i + 1;
      while (j < lambda.close && own(j) && (/[A-Za-z0-9.]/.test(text[j]) || (text[j] === ":" && /[0-9]/.test(text[j + 1] ?? "")))) {
        j++;
      }
      i = j;
    } else if (/[A-Za-z.]/.test(c)) {
      const j = run(/[A-Za-z0-9._]/, i + 1);
      const index = ["x", "y", "z"].indexOf(text.slice(i, j));
      highest = Math.max(highest, index);
      i = j;
    } else {
      i++;
    }
  }
  return ["x", "y", "z"].slice(0, highest + 1);
}

/// The statement that caches a call of a lambda taking `params` under `id`.
export function cacheStatement(id: string, params: string[]): string {
  const store = `${CACHE_NAMESPACE}.${id}`;
  if (params.length === 1) {
    return `${store}:${params[0]};\`${params[0]} set ${store};`;
  }
  return `${store}:(${params.join(";")});${params.map((p) => "`" + p).join("")} set'${store};`;
}

/// A fresh id: `p` and six hex digits, none of `taken`; the next one up
/// when the random one is taken.
export function newId(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  const start = Math.floor(random() * 0x1000000);
  for (let k = 0; ; k++) {
    const id = "p" + ((start + k) % 0x1000000).toString(16).padStart(6, "0");
    if (!used.has(id)) {
      return id;
    }
  }
}

/// Where an instrumented lambda's statement is: the text to delete.
interface Inserted {
  start: number;
  end: number;
  id: string;
}

const STORE = /^\.qlint\.cache\.(p[0-9a-f]{6}):/;

/// The statement q-lint inserted in `lambda`, exactly as it inserted it:
/// first in the body, on the `{` line or on a line of its own after it.
/// "none" when the lambda's own code names `.qlint.cache` nowhere;
/// "unrecognised" when it does, but not as q-lint inserted it.
function inserted(text: string, lambda: Lambda, params: string[], mask: boolean[]): Inserted | "none" | "unrecognised" {
  const own = ownCode(lambda, mask);
  let mentions = 0;
  for (let at = text.indexOf(CACHE_NAMESPACE + ".", lambda.bodyStart); at !== -1 && at < lambda.close; at = text.indexOf(CACHE_NAMESPACE + ".", at + 1)) {
    if (own(at)) {
      mentions++;
    }
  }
  if (mentions === 0) {
    return "none";
  }
  if (params.length === 0) {
    return "unrecognised";
  }
  const at = (from: number, before: number): Inserted | undefined => {
    const match = STORE.exec(text.slice(from, from + CACHE_NAMESPACE.length + 9));
    if (match === null) {
      return undefined;
    }
    const statement = cacheStatement(match[1], params);
    return text.startsWith(statement, from) && from + statement.length <= lambda.close
      ? { start: before, end: from + statement.length, id: match[1] }
      : undefined;
  };
  const line = /^[ \t]*(\r?\n)[ \t]+/.exec(text.slice(lambda.bodyStart, lambda.close));
  const found =
    at(lambda.bodyStart, lambda.bodyStart) ??
    (line === null ? undefined : at(lambda.bodyStart + line[0].length, lambda.bodyStart + line[0].indexOf(line[1])));
  // The statement names the namespace twice; any more is not q-lint's.
  return found !== undefined && mentions === 2 ? found : "unrecognised";
}

export type Toggle =
  | { kind: "insert"; offset: number; text: string; params: string[] }
  | { kind: "remove"; start: number; end: number; params: string[] }
  | { kind: "refuse"; message: string };

/// What Toggle Parameter Cache does at `offset`: insert the statement in the
/// lambda there, remove the one q-lint inserted, or refuse and say why.
export function toggleAt(text: string, offset: number, random: () => number = Math.random): Toggle {
  const mask = codeMask(text);
  const all = lambdas(text, mask);
  const lambda = lambdaAt(text, offset, all);
  if (lambda === undefined) {
    return { kind: "refuse", message: "q-lint: the cursor is in no lambda." };
  }
  const params = parameters(text, lambda, mask);
  const found = inserted(text, lambda, params, mask);
  if (found === "unrecognised") {
    return {
      kind: "refuse",
      message: `q-lint: this lambda names ${CACHE_NAMESPACE} in a form q-lint did not insert, or one edited since. Remove it by hand.`,
    };
  }
  if (found !== "none") {
    return { kind: "remove", start: found.start, end: found.end, params };
  }
  if (params.length === 0) {
    return {
      kind: "refuse",
      message:
        lambda.explicit !== undefined
          ? "q-lint: this lambda takes no parameters, so there is nothing to cache."
          : "q-lint: this lambda reads none of x, y and z, so it has no parameters to cache.",
    };
  }
  const statement = cacheStatement(newId(cachedIds(text, all, mask), random), params);
  return { kind: "insert", ...placement(text, lambda, statement), params };
}

/// Where the statement goes, and the text inserted there. When the `{` line
/// holds nothing after the parameters and the body goes on below, it gets a
/// line of its own, indented as the body's next line so q still reads it as
/// a continuation; otherwise it goes straight after the parameters.
function placement(text: string, lambda: Lambda, statement: string): { offset: number; text: string } {
  const rest = /^[ \t]*(\r?\n)/.exec(text.slice(lambda.bodyStart, lambda.close));
  if (rest === null) {
    return { offset: lambda.bodyStart, text: statement };
  }
  const eol = rest[1];
  const offset = lambda.bodyStart + rest[0].length - eol.length;
  const below = text.slice(offset + eol.length, lambda.close + 1).split(/\r?\n/);
  const next = below.find((l) => l.trim() !== "") ?? "";
  const indent = /^[ \t]*/.exec(next)![0] || " ";
  return { offset, text: eol + indent + statement };
}

/// The ids of every statement q-lint inserted in `text`.
function cachedIds(text: string, all: Lambda[], mask: boolean[]): string[] {
  return instrumented(text, all, mask).map((i) => i.id);
}

function instrumented(text: string, all: Lambda[], mask: boolean[]): Inserted[] {
  const out: Inserted[] = [];
  const walk = (level: Lambda[]): void => {
    for (const lambda of level) {
      const found = inserted(text, lambda, parameters(text, lambda, mask), mask);
      if (typeof found === "object") {
        out.push(found);
      }
      walk(lambda.children);
    }
  };
  if (text.includes(CACHE_NAMESPACE + ".")) {
    walk(all);
  }
  return out;
}

/// How many lambdas in `text` hold a statement q-lint inserted: what the
/// status bar counts.
export function cachedLambdas(text: string): number {
  if (!text.includes(CACHE_NAMESPACE + ".")) {
    return 0;
  }
  const mask = codeMask(text);
  return instrumented(text, lambdas(text, mask), mask).length;
}

/// What the status bar says: nothing when no lambda is cached.
export function cachedText(count: number): string | undefined {
  return count === 0 ? undefined : count === 1 ? "$(debug-breakpoint-log) params cached" : `$(debug-breakpoint-log) params cached (${count})`;
}
