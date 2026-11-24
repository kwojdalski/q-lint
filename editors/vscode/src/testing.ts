// The Test Explorer's data (#939): the tests the language server lists
// (`q-lint/tests`, the functions a Run test lens is drawn over - `test_*`
// and qUnit's `testName`), k4unit's CSV suites, and how one is run and
// judged on a q process. Free of any `vscode` import, so a test can drive
// it; `testexplorer.ts` is the view.
//
// `TEST_RUN` is sent as one lambda with the statements to run and a mode,
// and defines nothing of its own. It runs each statement with `value` -
// `\d .ns`, the definition, `\d .`, the call - and puts the process's `\d`
// back as it was, error or not. A test passes, in mode `test`, when nothing
// signals and the result is not false (`0b`, or a boolean list with a 0b in
// it): `.qt` and qUnit tests signal, and a k4unit-style one answers false.
// `true` passes only on `1b`, `fail` only on an error, `run` on anything
// but an error. `match` (#980) is a k4unit `true` row `a~b` sent as `(a;b)`:
// it passes when the two match, and a failure carries both sides.
//
//   `ok`failed`text`diff!(no error;failed;the result as .Q.s1 shows it, or
//                         the error;(expected;actual) as .Q.s shows them, or ())
//
// The two sides of a failure are those of a `match` row, or a qUnit
// assertion's: `.qunit.assertEquals` and `assertThat` keep them in
// `.qunit.ar` before they signal `assertThatFAIL`.
//
// On a process with qUnit, its `failFlag` and `ar` are cleared before the
// statements run, as `.qunit.runTest` clears them: the flag is sticky, and
// left set every later assertion signals (#1588). A test that ran an
// assertion is judged as qUnit judges it, by the flag and errors alone - an
// assertion returns the value it checked, so a false last value is no
// verdict (#1589) - and a flag set with `ignoreAllExceptions` fails it.

export const TEST_RUN = [
  "{[s;mode]",
  " s:{(),x} each (),s; mode:`$mode; d:system \"d\";",
  " qu:@[{99h=type get x};`.qunit;0b]; e:$[qu;@[get;`.qunit.EMPTYAR;()];()];",
  " if[qu;.qunit.ar:e;if[`failFlag in key`.qunit;.qunit.failFlag:0b]];",
  " r:@[{(1b;last value each x)};s;{(0b;x)}];",
  " system \"d \",string d;",
  " ok:r 0; v:r 1; m:();",
  " ff:qu&1b~@[get;`.qunit.failFlag;0b]; qt:ok&(mode~`test)&ff|qu&not e~@[get;`.qunit.ar;e];",
  " if[ok&mode~`match;m:v;v:$[2=count m;(~). m;0b];mode:`true];",
  " failed:$[mode~`fail;ok;not ok;1b;qt;ff;mode~`true;not 1b~v;mode~`run;0b;-1h=type v;not v;1h=type v;not all v;0b];",
  " q:$[ok;$[ff;@[get;`.qunit.ar;()];()];\"assertThatFAIL\"~v;@[get;`.qunit.ar;()];()];",
  " diff:{20000 sublist .Q.s x} each $[not failed;();2=count m;m 1 0;not 99h=type q;();all`actual`expected in key q;q`expected`actual;()];",
  " `ok`failed`text`diff!(ok;failed;$[ok;300 sublist .Q.s1 v;v];diff)}",
].join("\n");

/// The command that runs again the tests the last run failed (#980).
export const RERUN_FAILED = "q-lint.rerunFailedTests";

export type TestMode = "test" | "true" | "fail" | "run" | "match";

/// One test the language server lists: its name as written, where, the code
/// that defines it under its `\d`, and the call that runs it.
export interface ServerTest {
  name: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  code: string;
  call: string;
}

export interface ServerTestFile {
  uri: string;
  tests: ServerTest[];
}

const position = (v: unknown): v is { line: number; character: number } => {
  const p = v as { line?: unknown; character?: unknown } | null;
  return p !== null && typeof p === "object" && typeof p.line === "number" && typeof p.character === "number";
};

/// What `q-lint/tests` answered, keeping what is well formed.
export function readServerTests(raw: unknown): ServerTestFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const files: ServerTestFile[] = [];
  for (const file of raw as { uri?: unknown; tests?: unknown }[]) {
    if (file === null || typeof file !== "object" || typeof file.uri !== "string" || !Array.isArray(file.tests)) {
      continue;
    }
    const tests = (file.tests as Record<string, unknown>[]).filter(
      (t): t is ServerTest & Record<string, unknown> =>
        t !== null &&
        typeof t === "object" &&
        typeof t.name === "string" &&
        typeof t.code === "string" &&
        typeof t.call === "string" &&
        position((t.range as { start?: unknown } | undefined)?.start) &&
        position((t.range as { end?: unknown } | undefined)?.end),
    );
    if (tests.length > 0) {
      files.push({ uri: file.uri, tests: tests.map(({ name, range, code, call }) => ({ name, range, code, call })) });
    }
  }
  return files;
}

/// The statements that run a listed test: the code that defines it, one
/// `\d` line or definition at a time, then the call.
export function testStatements(test: Pick<ServerTest, "code" | "call">): string[] {
  const lines = test.code.split("\n");
  const statements: string[] = [];
  for (const line of lines) {
    // A `\d` line is a statement of its own; the definition between keeps
    // its continuation lines.
    if (line.startsWith("\\") || statements.length === 0 || statements[statements.length - 1].startsWith("\\")) {
      statements.push(line);
    } else {
      statements[statements.length - 1] += `\n${line}`;
    }
  }
  return [...statements, test.call];
}

export interface TestResult {
  passed: boolean;
  /// The result as q shows it, or the error's text.
  text: string;
  errored: boolean;
  /// A failed assertion's two sides, as q shows them, when it has them.
  diff?: { expected: string; actual: string };
}

/// What `TEST_RUN` answered. Throws when it is not its answer.
export function readTestResult(raw: unknown): TestResult {
  const r = raw as { ok?: unknown; failed?: unknown; text?: unknown } | null;
  if (r === null || typeof r !== "object" || typeof r.ok !== "boolean" || typeof r.failed !== "boolean") {
    throw new Error(`the process answered something other than a test's result: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const text = typeof r.text === "string" ? r.text : Array.isArray(r.text) ? r.text.join("") : String(r.text ?? "");
  const sides = (r as { diff?: unknown }).diff;
  const side = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.join("") : String(v));
  const diff = Array.isArray(sides) && sides.length === 2 ? { expected: side(sides[0]), actual: side(sides[1]) } : undefined;
  return { passed: !r.failed, text, errored: !r.ok, ...(diff !== undefined ? { diff } : {}) };
}

/// What a failed test's message says.
export function failureText(result: TestResult, mode: TestMode): string {
  if (mode === "fail") {
    return `expected an error, and it ran: ${result.text}`;
  }
  if (result.errored) {
    return `'${result.text}`;
  }
  if (mode === "match") {
    return "the two sides of ~ differ";
  }
  return mode === "true" ? `expected 1b, got ${result.text}` : `returned ${result.text}`;
}

/// A k4unit `true` row's `a~b` as the two sides, when `a` is one term - a
/// name, literal, string, symbol, or bracketed group, with any indexes
/// after it - so that q reads the row as `a ~ b`; undefined otherwise.
/// Sent as `(a;b)`, which q evaluates in the same order: `b` first.
export function splitMatch(code: string): { left: string; right: string } | undefined {
  const text = code.trim();
  if (text.includes("\n") || text.startsWith("k)")) {
    return undefined;
  }
  let depth = 0;
  let at = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // A string, with its escapes.
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") {
          i++;
        }
      }
      continue;
    }
    if (c === "/" && (i === 0 || /\s/.test(text[i - 1]))) {
      return undefined;
    }
    if ("([{".includes(c)) {
      depth++;
    } else if (")]}".includes(c)) {
      depth--;
    } else if (depth === 0 && c === "~" && at < 0) {
      at = i;
    } else if (depth === 0 && c === ";") {
      return undefined;
    }
  }
  if (at <= 0 || depth !== 0) {
    return undefined;
  }
  const left = text.slice(0, at).trim();
  const right = text.slice(at + 1).trim();
  return right !== "" && TERM.test(left) ? { left, right } : undefined;
}

/// One term of q, with any indexes: `f[1;2]`, `t\`a`, `(1+2)`, `1 2 3`,
/// `"ab"`, `` `a`b ``. A space or an operator outside brackets makes it more
/// than one, as q would read it.
const TERM = new RegExp(
  "^(?:" +
    [
      "-?[0-9][0-9a-zA-Z.:]*(?: -?[0-9][0-9a-zA-Z.:]*)*", // a number, or a vector of them
      '"(?:[^"\\\\]|\\\\.)*"', // a string
      "(?:`[A-Za-z0-9_.:/]*)+", // symbols
      "\\.?[A-Za-z][A-Za-z0-9_.]*", // a name
      "\\((?:[^()]|\\([^()]*\\))*\\)", // a group, nested once
    ].join("|") +
    ")(?:\\[[^\\]]*\\])*$",
);

// --- k4unit

/// One row of a k4unit suite: what to do (`before`, `after`, `true`,
/// `fail`, `run`, ...), the language (`q` or `k`), the code, and the line it
/// is on, from 0.
export interface K4Row {
  action: string;
  lang: string;
  code: string;
  line: number;
}

/// The fields of each CSV record in `text`, with the line each starts on: a
/// field in double quotes may hold commas, line breaks and `""`. A quote
/// opens quoting only at a field's start: elsewhere it is text, as q's `0:`
/// reads `s~"abc"` (#1410).
function csv(text: string): { fields: string[]; line: number }[] {
  const records: { fields: string[]; line: number }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 0;
  let start = 0;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === "\n") {
          line++;
        }
        field += c;
      }
    } else if (c === '"' && field === "" && (i === 0 || text[i - 1] === "," || text[i - 1] === "\n" || text[i - 1] === "\r")) {
      quoted = true;
      any = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
      any = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") {
        i++;
      }
      if (any || field !== "") {
        fields.push(field);
        records.push({ fields, line: start });
      }
      fields = [];
      field = "";
      any = false;
      line++;
      start = line;
    } else {
      field += c;
      any = true;
    }
  }
  if (any || field !== "") {
    fields.push(field);
    records.push({ fields, line: start });
  }
  return records;
}

/// The rows of a k4unit suite, or undefined when `text` is not one: its
/// header names `action`, `lang` and `code` among k4unit's columns
/// (`action,ms,bytes,lang,code,repeat,minver,comment`).
export function parseK4unit(text: string): K4Row[] | undefined {
  const records = csv(text);
  const header = records[0]?.fields.map((f) => f.trim().toLowerCase());
  const at = (name: string) => header?.indexOf(name) ?? -1;
  const [action, lang, code] = [at("action"), at("lang"), at("code")];
  if (action !== 0 || lang < 0 || code < 0 || at("ms") < 0) {
    return undefined;
  }
  return records
    .slice(1)
    .map(({ fields, line }) => ({
      action: (fields[action] ?? "").trim().toLowerCase(),
      lang: (fields[lang] ?? "").trim().toLowerCase() || "q",
      code: fields[code] ?? "",
      line,
    }))
    .filter((row) => row.action !== "" && row.code.trim() !== "" && !row.action.startsWith("comment"));
}

/// Whether a row is a test of its own: the others set up and tear down.
export function isK4Test(row: K4Row): boolean {
  return row.action === "true" || row.action === "fail" || row.action === "run";
}

/// How a k4unit row is judged.
export function k4Mode(row: K4Row): TestMode {
  return row.action === "true" ? "true" : row.action === "fail" ? "fail" : "run";
}

/// The statement a row sends: k code through `k)`.
export function k4Statement(row: K4Row): string {
  return row.lang === "k" ? `k)${row.code}` : row.code;
}

/// What a test's label is: a k4unit row is its code, cut to one line of 80
/// characters - by code point, never inside a surrogate pair (#1473).
export function k4Label(row: K4Row): string {
  const one = Array.from(row.code.replace(/\s+/g, " ").trim());
  return one.length > 80 ? `${one.slice(0, 79).join("")}…` : one.join("");
}
