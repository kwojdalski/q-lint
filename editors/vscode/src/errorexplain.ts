// The offline error explainer (#1054), as data: what a q error means, what
// usually causes it, and - given the backtrace q printed with it - the
// operation that failed. Free of any `vscode` import, so node tests it;
// `errorexplainview.ts` makes the command and the Quick Fix.
//
// Nothing here asks a process or a model: the catalogue is below, and every
// entry marked `seen` was produced by the example beside it on both KDB-X
// and PeachQ, with the message each printed (`errorexplain.test.js` holds
// the examples, and runs them under QLINT_TEST_Q). The entries marked
// `documented` are from the KX reference (code.kx.com/q/basics/errors) and
// were not produced here: running out of memory, or a process refusing a
// write, is not something a test does to the machine it runs on.
import { parseBacktrace } from "./backtrace";
import { span } from "./helpcatalog";

export interface QError {
  /// What it means, in a sentence.
  meaning: string;
  /// What usually causes it.
  causes: string[];
  /// A line that raises it, as run.
  example?: string;
  /// `seen`: produced by `example` on KDB-X and PeachQ. `kdbx`: on KDB-X,
  /// which PeachQ reports another way (`peachq` says how). `documented`:
  /// from the KX reference only.
  checked: "seen" | "kdbx" | "documented";
  peachq?: string;
}

export const ERRORS: Record<string, QError> = {
  type: {
    meaning: "An argument is of a type the operation does not take.",
    causes: [
      "A symbol in arithmetic, or compared with a number or a string (`` 1+`a ``, `` `a=\"a\" ``).",
      "A string where a symbol was meant, or the reverse: a column read from CSV as text.",
      "Indexing with the wrong type: a symbol into a list, a float as an index.",
      "A join or an aj of columns whose types differ between the two tables.",
    ],
    example: "1+`a",
    checked: "seen",
  },
  length: {
    meaning: "Two lists that have to be the same length are not.",
    causes: [
      "An atomic operation on two vectors of different counts (`1 2+1 2 3`).",
      "A table or dictionary built from columns or keys and values of different counts.",
      "An update or insert with a value list that does not match the rows or columns.",
    ],
    example: "1 2+1 2 3",
    checked: "seen",
  },
  rank: {
    meaning: "A function was given more arguments than it takes.",
    causes: [
      "A lambda called with one argument too many (`{x+y}[1;2;3]`).",
      "A projection applied once more than it has slots left.",
      "A name meant as a list indexed at depth, where it holds a function.",
    ],
    example: "{x+y}[1;2;3]",
    checked: "seen",
  },
  domain: {
    meaning: "An argument is of the right type but outside the values the operation takes.",
    // Each raises it on KDB-X and PeachQ; a roll from an empty list does
    // not, and a deal past its range is 'length (#2169).
    causes: ["A negative count to `til` (`til -1`).", "A negative right argument to roll (`1?-1`)."],
    example: "til -1",
    checked: "seen",
  },
  nyi: {
    meaning: "Not yet implemented: q has no meaning for this combination of arguments.",
    causes: ["A keyword applied with brackets to more arguments than it has (`count[1;2]`).", "A primitive given a shape it does not support."],
    example: "count[1;2]",
    checked: "seen",
  },
  limit: {
    meaning: "A list, a take or a serialisation would be larger than q allows.",
    causes: ["A take of a huge count (`0W#0`).", "Serialising or sending more than the IPC limit."],
    example: "0W#0",
    checked: "kdbx",
    peachq: "PeachQ reports 'oom for the example.",
  },
  oom: {
    meaning: "PeachQ's message for an allocation it could not make: what KDB-X reports as 'limit or 'wsfull.",
    causes: ["A take or a list far larger than memory."],
    example: "0W#0",
    checked: "documented",
  },
  wsfull: {
    meaning: "The process ran out of memory (or reached the -w limit it was started with).",
    causes: ["A query that materialises far more than it needs: select every column of a large table, a cross join.", "Data held from earlier queries; `.Q.gc[]` returns what is free."],
    checked: "documented",
  },
  assign: {
    meaning: "An assignment to a name q reserves.",
    causes: ["A builtin's name used as a variable (`cos:1`, `count:3`).", "A name added to `.q` earlier, then assigned."],
    example: "cos:1",
    checked: "seen",
  },
  match: {
    meaning: "A lambda's parameters or a pattern do not match what was given.",
    causes: ["A builtin's name used as a parameter, refused on every call by q 5 (`{[count] count}[1]`).", "A pattern assignment whose shape differs from the value (q 4.1)."],
    example: "{[count] count}[1]",
    checked: "kdbx",
    peachq: "PeachQ reports 'assign for the example.",
  },
  stype: {
    meaning: "Something other than a string or a symbol was signalled.",
    causes: ["`'` applied to a number (`'1`) or a char atom."],
    example: "'1",
    checked: "seen",
  },
  mismatch: {
    meaning: "Two tables that have to have the same columns do not.",
    causes: ["Joining or upserting tables with different column names or orders (`([]a:1 2),([]b:1 2)`)."],
    example: "([]a:1 2),([]b:1 2)",
    checked: "seen",
  },
  "u-fail": {
    meaning: "The unique attribute was applied to a list with duplicates.",
    causes: ["`` `u# `` on a column that repeats a value, or an append that adds one."],
    example: "`u#1 1",
    checked: "seen",
  },
  "s-fail": {
    meaning: "The sorted attribute was applied to a list that is not sorted.",
    causes: ["`` `s# `` on an unsorted column, or an append that breaks the order."],
    example: "`s#2 1",
    checked: "seen",
  },
  insert: {
    meaning: "An insert into a keyed table repeats a key it already has.",
    causes: ["Inserting a row whose key exists; `upsert` replaces it instead."],
    example: "t:([k:1 2]v:3 4);`t insert(1;5)",
    checked: "seen",
  },
  stack: {
    meaning: "Too deep a recursion: q's stack is full.",
    causes: ["A function that calls itself with no case that stops it (`f:{f x}`).", "Very deep nesting of calls or parse trees."],
    example: "f:{f x};f 1",
    checked: "seen",
  },
  from: {
    meaning: "A qSQL query has no `from` where q looked for one.",
    causes: ["A `select`, `exec`, `update` or `delete` with `from` left out or misspelt.", "`from` with no table after it.", "A `;` where a `,` was meant between two columns (`select v;w from t`)."],
    example: "select v t",
    checked: "kdbx",
    peachq: "PeachQ reports 'parse for the example.",
  },
  parse: {
    meaning: "The text could not be parsed as q.",
    causes: ["An unbalanced bracket or quote in code given to `parse` or `value`."],
    example: "parse\"1+)\"",
    checked: "documented",
    peachq: "PeachQ reports 'parse for the example; KDB-X names the token it stopped at.",
  },
  access: {
    meaning: "The process refuses the operation: it runs under -u, -b or reval.",
    causes: ["A write, a system command or a global assignment sent to a read-only process."],
    checked: "documented",
  },
  noupdate: {
    meaning: "An update of a global from a thread that may not make one (a peach worker, or under -b).",
    causes: ["Assigning a global inside `peach`."],
    checked: "documented",
  },
  nosocket: {
    meaning: "A handle used where no socket is open, or from a thread that may not use one.",
    causes: ["A handle used inside `peach` (q 4.1).", "A handle closed earlier."],
    checked: "documented",
  },
  splay: {
    meaning: "An operation that a splayed table does not support.",
    causes: ["Writing a nested column or an unenumerated symbol column to a splayed table."],
    checked: "documented",
  },
  par: {
    meaning: "An operation on a partitioned table that it does not support.",
    causes: ["Updating or deleting rows of a partitioned table in memory."],
    checked: "documented",
  },
  hop: {
    meaning: "`hopen` could not open the connection.",
    causes: ["No process listens on that host and port, or a firewall refuses it.", "The process refused the user and password given."],
    example: "hopen`::1",
    checked: "seen",
  },
  io: {
    meaning: "PeachQ's message for a file it could not read or write: what KDB-X reports with \"OS reports\".",
    causes: ["A path that does not exist, or that the process may not read."],
    checked: "documented",
  },
};

/// The error as q printed it: without the quote, and the timestamp a
/// console puts before it.
function printed(text: string): string {
  return text.trim().replace(/^'/, "").replace(/^\d{4}\.\d\d\.\d\dT[\d:.]+\s+/, "");
}

/// The error's name: `'type` and `type` are `type`; an OS error -
/// `name. OS reports: ...` - is `os`; anything after the first blank is
/// dropped, as q's own messages are one word but for those.
export function errorName(text: string): string {
  const t = printed(text);
  if (/OS reports:/.test(t)) {
    return /^hop\b/.test(t) ? "hop" : "os";
  }
  return t.split(/\s/)[0] ?? "";
}

/// Markdown `code` that holds any backtick: fenced by a run longer than
/// any in it, as the help hover's are (#1312).
const code = span;

/// What failed, from a backtrace: the innermost frame q marked with `^`,
/// its line and the token under the caret.
export function failedAt(trace: string): string | undefined {
  const frames = parseBacktrace(trace);
  const frame = frames.find((f) => f.failed !== undefined);
  if (frame?.failed === undefined) {
    return undefined;
  }
  const line = frame.code[frame.failed.index] ?? "";
  const column = frame.failed.column;
  const rest = line.slice(column);
  const token = /^(<=|>=|<>|[^\sA-Za-z0-9_.`"]|[A-Za-z_.][A-Za-z0-9_.]*|`[A-Za-z0-9_.:]*|\S)/.exec(rest)?.[0] ?? "";
  const where = frame.file !== undefined ? ` (${frame.file}, line ${frame.line})` : "";
  const name = frame.name !== undefined ? ` in ${code(frame.name)}` : "";
  return `The operation that failed${name}${where}: ${code(line.trim())}, at ${token ? code(token) : `column ${column + 1}`}.`;
}

/// The explanation of `error` as Markdown, with the failed operation when
/// `trace` shows it.
export function explainError(error: string, trace?: string): string {
  const name = errorName(error);
  // Own entries only: `'constructor` is not Object.prototype's (#1078).
  const entry = Object.hasOwn(ERRORS, name) ? ERRORS[name] : undefined;
  // More than one word on its line is no name q could not find, but what
  // the code said with `'` (#1902).
  const said = (printed(error).split("\n")[0] ?? "").trim();
  const message = name !== "os" && entry === undefined && /\s/.test(said);
  const lines: string[] = [`# q error ${code(`'${message ? said : name}`)}`, ""];
  if (name === "os") {
    lines.push("The operating system refused a file or network operation; its own message follows q's:", "", "> " + error.trim(), "");
    lines.push("Check that the path exists, that the process may read or write it, and that a relative path is relative to the process's working directory, not the editor's.");
  } else if (entry !== undefined) {
    lines.push(entry.meaning, "", "**Likely causes**", "", ...entry.causes.map((c) => `- ${c}`));
    if (entry.example !== undefined) {
      lines.push("", `For example ${code(entry.example)}.`);
    }
    if (entry.peachq !== undefined) {
      lines.push("", entry.peachq);
    }
    if (entry.checked === "documented") {
      lines.push("", "_From the KX reference; not produced in q-lint's tests._");
    }
  } else if (message) {
    lines.push(
      "This is not one of q's own errors, which are one word: it is a message the code signalled, with `'` (signal) or through a library that signals for it (`.j.k` on JSON it cannot read).",
      "",
      "**Where to look**",
      "",
      "- The text of the message, searched for in the workspace and in the libraries the process loaded.",
      "- The backtrace, when there is one: its innermost frame is the function that signalled.",
    );
  } else if (/^[.A-Za-z][A-Za-z0-9_.]*$/.test(name)) {
    lines.push(
      `${code(name)} is not defined where it was read: q signals a name it cannot find as an error of that name.`,
      "",
      "**Likely causes**",
      "",
      "- A typo, or a name defined in another file or process that was not loaded.",
      "- A name defined under another `\\d` context: inside `\\d .ns` it is `.ns." + name + "`.",
      "- A file that does not exist, read with `get` or `value` by this name.",
      `- A value that is not in an enumeration's domain, when ${code(name)} is the domain (\`\`sym$\`zzz\`\` is 'sym).`,
    );
  } else {
    lines.push("q-lint has no explanation for this error.", "", "> " + error.trim());
  }
  const failed = trace ? failedAt(trace) : undefined;
  if (failed !== undefined) {
    lines.push("", "**Where**", "", failed);
  }
  return lines.join("\n") + "\n";
}

/// The q error a diagnostic's message names (`'type`, `'length`, ...), so a
/// Quick Fix can explain it; undefined for one that names none the
/// catalogue has.
export function errorInMessage(message: string): string | undefined {
  for (const m of message.matchAll(/'([A-Za-z][A-Za-z-]*)/g)) {
    if (Object.hasOwn(ERRORS, m[1])) {
      return m[1];
    }
  }
  return undefined;
}
