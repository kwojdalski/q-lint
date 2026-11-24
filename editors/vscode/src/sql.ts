// The SQL tab for KDB-X (#1061), as data: the q that runs a SQL statement
// on a process's SQL engine, what in a statement would change the process,
// and the completions a process's tables give. Free of any `vscode` import,
// so node tests it; `sqlview.ts` makes the editor and the commands.
//
// KDB-X's SQL engine is `.s.e`, a function of the SQL text that returns a
// table, defined once `s.k_` is loaded (`\l s.k_`, from QHOME): checked on
// KDB-X 5, where `.s.e` is not defined until then and `.s.e "select sym,
// sum(size) as total from t group by sym"` returns a table. It also runs
// `insert into t values (...)`, which changes the table. PeachQ defines a
// `.s.e` of its own, backed by DuckDB, which refuses every statement with
// 'duckdb where DuckDB is not installed.

/// Whether the process has `.s.e`: a fixed read, answered `1b` or `0b`.
export const HAS_SQL = "{`e in key `.s}[]";

/// Loading KDB-X's SQL engine: a system command, which the read-only guard
/// asks about on a guarded process.
export const LOAD_SQL = "system \"l s.k_\"";

/// Each table of the process with its columns, a fixed read.
export const SQL_SCHEMA = "{t!cols each t:tables[]}[]";

/// The SQL text `sqlQuery` sends for `sql`: its `--` comments dropped (a
/// comment would swallow the rest once lines are joined) and its lines
/// joined by a blank. What is a comment is the engine's lexer's to say
/// (`lex`): a `--` in quoted text or inside `/* */` is not one, and a quote
/// inside `/* */` opens nothing (#1956). The read-only check judges this
/// text, not `sql` as typed (#1408).
export function sqlText(sql: string): string {
  const read = lex(sql);
  let kept = "";
  for (let i = 0; i < sql.length; i++) {
    kept += read[i] === "-" ? "" : sql[i];
  }
  return kept.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").join(" ").replace(/;\s*$/, "");
}

/// `sql` sent to `.s.e` as a q string, as `sqlText` gives it. `load`: load
/// the engine first where the process has none, for a process not yet asked.
export function sqlQuery(sql: string, load = false): string {
  const text = sqlText(sql);
  const literal = `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return load ? `{if[not \`e in key \`.s;system "l s.k_"];.s.e x} ${literal}` : `.s.e ${literal}`;
}

/// Words that change data or schema wherever they stand in a statement:
/// KDB-X runs `/* c */ insert into t ...` as an insert, so a statement's
/// first word is not enough.
const WRITE_WORDS = ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "TRUNCATE", "MERGE"];

/// KDB-X's SQL lexer, the state machine `.s.P.w` runs over the text `.s.e`
/// is given: read from `.s.P.w0` and `.s.P.ww` of s.k_ 1.1 on KDB-X 5, and
/// compared with the tables of the q under test by `languagetools_q`.
/// `LEX_CLASS` has the class of each character up to `~`, 0 to 12 as one
/// base-13 digit. A row of `LEX_MOVES` is a state's name and then the state
/// each class moves it to: `!` is a `--` comment, `C` and `D` a `/* */`
/// one, `'tu` and `"vw` quoted text.
export const LEX_CLASS = "1111111110111111111111111111111105b5255a229227c84444444444525555533336333333333333333333333212535333363333333333333333333332525";
export const LEX_MOVES = [
  "   +a0<a%/+'\"0", "+  +a0<a%/+'\"0", "a  +bb<b%/+'\"%", "0  +a1<e%/+'\"1", "<  +a0>a%/+'\"0", "'ttttttttttutt", "\"vvvvvvvvvvvwv",
  "%  +a0<a!/+'\"0", "/  +a0<a%/C'\"0", "!! !!!!!!!!!!!", "#  +*1<e!/+'\"0", "b  +bb<b%/+'\"%", "1  +*1<e%/+'\"1", "CCCCCCCCCCDCCC",
  "DCCCCCCCC DCCC", ">  +a0<a%/+'\"0", "e  +*1<*#/+'\"0", "tttttttttttutt", "u  +a0<a%/+t\"0", "vvvvvvvvvvvvwv", "w  +a0<a%/+'v0",
];

/// What each character of `sql` is to that lexer: `-` in a `--` comment,
/// `*` in a `/* */` one, `'` in quoted text, a blank where it separates
/// words and `.` otherwise. It is not SQL's reading: a `--` comment ends at
/// any control character but a tab, and at a backslash, all of them blanks
/// (#1955); a quote in a comment opens nothing; quoted text runs across
/// lines, a doubled quote its only escape.
function lex(sql: string): string {
  const moves = new Map(LEX_MOVES.map((row) => [row[0], row.slice(1)]));
  const out: string[] = [];
  let state = " ";
  for (let i = 0; i < sql.length; i++) {
    const code = sql.charCodeAt(i);
    // KDB-X refuses the whole text ('lexer unexpected) at a character past
    // the table and at a move the table lacks (`*`: a letter straight after
    // a number's exponent), so nothing runs: read on as a letter and a
    // name, which neither end nor hide anything.
    const kind = code < LEX_CLASS.length ? parseInt(LEX_CLASS[code], 13) : 3;
    const moved = (moves.get(state) ?? "")[kind];
    const next = moved === "*" || moved === undefined ? "a" : moved;
    if (next === "!") {
      // `.-` after a name moves as `--` does, but the engine refuses that
      // token: what follows it stays readable.
      const opens = state !== "!" && sql[i - 1] === "-";
      out.push(opens || out[i - 1] === "-" ? "-" : ".");
      if (opens) {
        out[i - 1] = "-";
      }
    } else if (next === "C" || next === "D" || state === "D") {
      // `state === "D"`: the `/` that closes the comment.
      out.push("*");
      if (state === "/") {
        out[i - 1] = "*";
      }
    } else if ("'tu\"vw".includes(next)) {
      out.push("'");
    } else {
      out.push(kind < 2 ? " " : ".");
    }
    state = next;
  }
  return out.join("");
}

/// `sql` as KDB-X's lexer reads it, without its comments and with its
/// quoted text blanked, so neither can hide or fake a statement's words.
function bare(sql: string): string {
  const read = lex(sql);
  return [...read].map((c, i) => (c === "." ? sql[i] : " ")).join("");
}

/// The same by SQL's own rules, as an engine other than KDB-X's may read
/// it: `--` to the end of the line, `/* ... */`, and quoted text (`'...'`,
/// `"..."`, doubled quotes inside).
function bareByLine(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end - 1;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) {
        j += sql[j] === c ? 2 : 1;
      }
      i = j;
      out += " ";
    } else {
      out += c;
    }
  }
  return out;
}

/// The words in `sql` that change data or schema, upper-cased, once each:
/// a write word anywhere outside comments and quotes, and `REPLACE` where
/// it starts a statement (elsewhere it is the string function). Where the
/// two readings of comments and quotes differ, a word either shows counts:
/// the read-only guard is asked rather than not.
export function sqlWrites(sql: string): string[] {
  const words = new Set<string>();
  for (const text of [bare(sql), bareByLine(sql)]) {
    for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const w = m[0].toUpperCase();
      if (WRITE_WORDS.includes(w)) {
        words.add(w);
      }
    }
    if (/(?:^|[;(])\s*replace\b/i.test(text)) {
      words.add("REPLACE");
    }
  }
  return [...words];
}

/// The schema a process answered, as table names to their columns.
export function readSchema(answer: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    // A q dictionary decodes to an object; keys may arrive as symbols or
    // strings.
    for (const [table, columns] of Object.entries(answer as Record<string, unknown>)) {
      if (Array.isArray(columns)) {
        out.set(table, columns.filter((c): c is string => typeof c === "string"));
      }
    }
  }
  return out;
}

/// What to offer at the end of `before`, the text up to the cursor: the
/// columns of `table.` when it names one, else every table and column.
export function sqlCompletions(schema: Map<string, string[]>, before: string): { label: string; kind: "table" | "column"; detail: string }[] {
  const dotted = /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/.exec(before);
  if (dotted !== null && schema.has(dotted[1])) {
    return (schema.get(dotted[1]) ?? []).map((c) => ({ label: c, kind: "column", detail: dotted[1] }));
  }
  const out: { label: string; kind: "table" | "column"; detail: string }[] = [];
  const seen = new Set<string>();
  for (const [table, columns] of schema) {
    out.push({ label: table, kind: "table", detail: `table, ${columns.length} columns` });
    for (const c of columns) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push({ label: c, kind: "column", detail: `column of ${table}` });
      }
    }
  }
  return out;
}
