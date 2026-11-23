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

/// `sql` sent to `.s.e` as a q string, its `--` comments dropped (a comment
/// would swallow the rest once lines are joined) and its lines joined by a
/// blank. `load`: load the engine first where the process has none, for a
/// process not yet asked.
export function sqlQuery(sql: string, load = false): string {
  const lines = sql.split(/\r?\n/).map((line) => {
    // The quote a quoted text opened, `'` or `"`: the other is text in it.
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'" || c === '"') {
        quote = quote === undefined ? c : quote === c ? undefined : quote;
      } else if (quote === undefined && c === "-" && line[i + 1] === "-") {
        return line.slice(0, i);
      }
    }
    return line;
  });
  const text = lines.map((l) => l.trim()).filter((l) => l !== "").join(" ").replace(/;\s*$/, "");
  const literal = `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return load ? `{if[not \`e in key \`.s;system "l s.k_"];.s.e x} ${literal}` : `.s.e ${literal}`;
}

/// Words that change data or schema wherever they stand in a statement:
/// KDB-X runs `/* c */ insert into t ...` as an insert, so a statement's
/// first word is not enough.
const WRITE_WORDS = ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "TRUNCATE", "MERGE"];

/// `sql` without its comments (`--` to the end of the line, `/* ... */`)
/// and with its quoted text (`'...'`, `"..."`, doubled quotes inside)
/// blanked, so neither can hide or fake a statement's words.
function bare(sql: string): string {
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
/// it starts a statement (elsewhere it is the string function).
export function sqlWrites(sql: string): string[] {
  const words = new Set<string>();
  const text = bare(sql);
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const w = m[0].toUpperCase();
    if (WRITE_WORDS.includes(w)) {
      words.add(w);
    }
  }
  if (/(?:^|[;(])\s*replace\b/i.test(text)) {
    words.add("REPLACE");
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
