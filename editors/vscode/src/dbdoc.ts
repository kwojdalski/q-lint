// The database documenter (#1023): a process's tables - columns, types,
// attributes, keys, foreign keys, partitions and rows - and its functions
// with their parameters, as a Markdown or an HTML document, with the qDoc
// comment written above a function in the workspace where there is one.
// Free of any `vscode` import, so node tests it; `dbtoolsview.ts` asks the
// process and opens the document.
//
// One read, defining nothing: `meta` of each table in the root (a
// partitioned one's reads its last partition's schema), its rows counted as
// the explorer counts them (`.Q.cn` for a partitioned table), and the
// functions of the root and of every namespace that is not q's own (KDB-X's
// SQL `.s` among them, #1576), at most
// `lim` of each. Only a lambda has parameters of its own: `(value f)1` of a
// projection is its bound argument, of a composition a part (#1575). Works on kdb+ (KDB-X) and PeachQ; held there by
// dbtools_q.test.js.
import { SLOT_TEXT, slotParams } from "./paramcache";
import { definitions } from "./definitions";
import { blockDepth } from "./statements";

export const DOCUMENT = [
  "{[lim]",
  " m:\"j\"$lim;",
  " ts:m sublist tables`.;",
  " one:{[t] v:get t;p:.Q.qp v;part:1b~p;disk:part|0b~p;mt:0!meta v;",
  "  `name`kind`rows`keys`cols`types`fkeys`attrs`error!(string t;",
  "   string$[part;`partitioned;disk;`splayed;99h=type v;`keyed;`table];",
  "   \"f\"$$[part;@[{sum .Q.cn x};v;0n];count v];",
  "   string$[99h=type v;(),keys v;`$()];",
  "   string mt`c;{$[null x;enlist\" \";enlist x]}each mt`t;string mt`f;string mt`a;\"\")};",
  // A table `meta` refuses - its enumeration domain gone, say - is an entry
  // with q's error, as SCHEMA's is, and not the end of the document (#1868).
  " bad:{[t;e] `name`kind`rows`keys`cols`types`fkeys`attrs`error!(string t;\"\";0n;();();();();();$[10h=type e;e;string e])};",
  " ns:(key`)except`q`Q`h`j`o`s`z`m`qlint;",
  " ns:ns where not null ns;ns:ns where{99h=type get` sv`,x}each ns;",
  // A dictionary held at a dotted name is listed among the namespaces, and
  // `\f` of one that is no context signals: it has no functions (#1867).
  " fs:m sublist(system\"f\"),raze{@[{` sv'(` sv`,x),/:system\"f \",string` sv`,x};x;`$()]}each ns;",
  " `pf`parts`tables`fnames`fparams`ftexts!(",
  "  $[@[{0<count .Q.pv};::;0b];string .Q.pf;\"\"];",
  "  \"f\"$@[{count .Q.pv};::;0];",
  "  {[one;bad;t] @[one;t;bad t]}[one;bad] each ts;",
  "  string fs;{@[{f:get x;$[100h=type f;string(value f)1;()]};x;()]}each fs;",
  `  {@[{f:get x;$[100h=type f;${SLOT_TEXT} f;""]};x;""]}each fs)}`,
].join("\n");

/// Tables and functions a document covers at most.
export const DOCUMENT_LIMIT = 2000;

export interface DocTable {
  name: string;
  kind: string;
  rows: number | null;
  keys: string[];
  columns: { name: string; type: string; fkey: string; attr: string }[];
  /// q's error, when the process could not describe the table.
  error?: string;
}

export interface DbDoc {
  field: string;
  partitions: number;
  tables: DocTable[];
  functions: { name: string; params: string[] }[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null || s === undefined ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/// A table of one row can come as one dictionary, and a list of one string
/// as the string: both read as lists.
const rowsOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : v !== null && typeof v === "object" ? [v as Record<string, unknown>] : [];

/// What `DOCUMENT` answered. Throws when it is not that.
export function readDoc(raw: unknown): DbDoc {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !("tables" in r) || !("fnames" in r)) {
    throw new Error(`the process answered something other than its tables: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const tables = rowsOf(r.tables).map((t): DocTable => {
    const names = strings(t.cols);
    const types = strings(t.types);
    const fkeys = strings(t.fkeys);
    const attrs = strings(t.attrs);
    const error = strings(t.error).join("");
    return {
      name: strings(t.name).join(""),
      kind: strings(t.kind).join(""),
      rows: number(t.rows),
      keys: strings(t.keys),
      columns: names.map((name, i) => ({ name, type: (types[i] ?? "").trim(), fkey: fkeys[i] ?? "", attr: attrs[i] ?? "" })),
      ...(error === "" ? {} : { error }),
    };
  });
  const fnames = strings(r.fnames);
  const params = Array.isArray(r.fparams) ? r.fparams : [];
  const texts = Array.isArray(r.ftexts) ? r.ftexts : [];
  const text = (i: number): string | undefined => (typeof texts[i] === "string" ? texts[i] : undefined);
  return {
    field: strings(r.pf).join(""),
    partitions: number(r.parts) ?? 0,
    tables,
    functions: fnames.map((name, i) => ({
      name,
      params: slotParams(fnames.length === 1 && !Array.isArray(params[0]) ? strings(params) : strings(params[i]), text(i)),
    })),
  };
}

/// The comment block written right above each function a q file defines,
/// its comment characters taken off: `/// text`, `/ text`, and a `/` ...
/// `\` block. By name, as `definitions` names them.
export function qdocs(source: string): Map<string, string> {
  const lines = source.split(/\r?\n/);
  // Each line's block comment depth before it: block comments nest (#1817).
  const depth: number[] = [];
  lines.reduce((d, line, i) => ((depth[i] = d), blockDepth(d, line.trim())), 0);
  const out = new Map<string, string>();
  for (const def of definitions(source)) {
    const above: string[] = [];
    for (let i = def.line - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "\\") {
        // A block comment's close: back to the `/` that opened it, a
        // nested block and all.
        if (depth[i] !== 1) break;
        let j = i - 1;
        while (j >= 0 && depth[j] !== 0) j--;
        if (j < 0) break;
        above.unshift(...lines.slice(j + 1, i).map((l) => l.trim()));
        i = j;
        continue;
      }
      if (!line.startsWith("/") || line === "/") break;
      above.unshift(line.replace(/^\/+\s?/, ""));
    }
    if (above.length > 0) {
      out.set(def.name, above.join("\n").trim());
    }
  }
  return out;
}

const TYPE_NAMES: Record<string, string> = {
  b: "boolean", g: "guid", x: "byte", h: "short", i: "int", j: "long", e: "real", f: "float", c: "char", s: "symbol",
  p: "timestamp", m: "month", d: "date", z: "datetime", n: "timespan", u: "minute", v: "second", t: "time",
};
const ATTRS: Record<string, string> = { s: "sorted", u: "unique", p: "parted", g: "grouped" };

/// A type character as people read it: `j` long, `C` list of char.
export function typeName(t: string): string {
  if (t === "" || t === " ") return "mixed";
  const name = TYPE_NAMES[t.toLowerCase()];
  return name === undefined ? t : t === t.toUpperCase() ? `list of ${name}` : name;
}

const md = (s: string) => s.replace(/([\\`*_{}[\]<>|#])/g, "\\$1");
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rowsText = (n: number | null) => (n === null ? "not counted" : n.toLocaleString("en-US"));

/// The document as Markdown. `docs`: each function's qDoc, by name.
export function docMarkdown(doc: DbDoc, process: string, at: string, docs: Map<string, string> = new Map()): string {
  const out = [`# ${md(process)}`, "", `Documented by q-lint on ${md(at)}.`, ""];
  if (doc.field !== "") {
    out.push(`A partitioned database by ${md(doc.field)}, ${doc.partitions.toLocaleString("en-US")} partitions.`, "");
  }
  out.push("## Tables", "");
  if (doc.tables.length === 0) out.push("No tables.", "");
  for (const t of doc.tables) {
    if (t.error !== undefined) {
      out.push(`### ${md(t.name)}`, "", `Not read: ${md(t.error)}.`, "");
      continue;
    }
    out.push(`### ${md(t.name)}`, "", `${md(t.kind)}, ${rowsText(t.rows)} rows${t.keys.length ? `, keyed by ${t.keys.map(md).join(", ")}` : ""}.`, "");
    out.push("| column | type | attribute | foreign key |", "| --- | --- | --- | --- |");
    for (const c of t.columns) {
      out.push(`| ${md(c.name)}${t.keys.includes(c.name) ? " (key)" : ""} | ${md(typeName(c.type))} | ${ATTRS[c.attr] ?? ""} | ${md(c.fkey)} |`);
    }
    out.push("");
  }
  out.push("## Functions", "");
  if (doc.functions.length === 0) out.push("No functions.", "");
  for (const f of doc.functions) {
    out.push(`### ${md(f.name)}[${f.params.map(md).join(";")}]`, "");
    const d = docs.get(f.name);
    out.push(d === undefined ? "No qDoc in the workspace." : d.split("\n").map(md).join("  \n"), "");
  }
  return out.join("\n");
}

/// The document as one HTML page, with no script and nothing fetched.
export function docHtml(doc: DbDoc, process: string, at: string, docs: Map<string, string> = new Map()): string {
  const out = [
    "<!DOCTYPE html>",
    `<html lang="en"><head><meta charset="UTF-8"><title>${html(process)}</title>`,
    "<style>body{font-family:sans-serif;max-width:60em;margin:2em auto;padding:0 1em}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 8px;text-align:left}pre{white-space:pre-wrap}</style>",
    "</head><body>",
    `<h1>${html(process)}</h1>`,
    `<p>Documented by q-lint on ${html(at)}.</p>`,
  ];
  if (doc.field !== "") {
    out.push(`<p>A partitioned database by ${html(doc.field)}, ${doc.partitions.toLocaleString("en-US")} partitions.</p>`);
  }
  out.push("<h2>Tables</h2>");
  if (doc.tables.length === 0) out.push("<p>No tables.</p>");
  for (const t of doc.tables) {
    if (t.error !== undefined) {
      out.push(`<h3 id="t-${html(t.name)}">${html(t.name)}</h3>`, `<p>Not read: ${html(t.error)}.</p>`);
      continue;
    }
    out.push(`<h3 id="t-${html(t.name)}">${html(t.name)}</h3>`, `<p>${html(t.kind)}, ${rowsText(t.rows)} rows${t.keys.length ? `, keyed by ${t.keys.map(html).join(", ")}` : ""}.</p>`);
    out.push("<table><tr><th>column</th><th>type</th><th>attribute</th><th>foreign key</th></tr>");
    for (const c of t.columns) {
      out.push(`<tr><td>${html(c.name)}${t.keys.includes(c.name) ? " (key)" : ""}</td><td>${html(typeName(c.type))}</td><td>${ATTRS[c.attr] ?? ""}</td><td>${html(c.fkey)}</td></tr>`);
    }
    out.push("</table>");
  }
  out.push("<h2>Functions</h2>");
  if (doc.functions.length === 0) out.push("<p>No functions.</p>");
  for (const f of doc.functions) {
    const d = docs.get(f.name);
    out.push(`<h3>${html(f.name)}[${f.params.map(html).join(";")}]</h3>`, d === undefined ? "<p>No qDoc in the workspace.</p>" : `<pre>${html(d)}</pre>`);
  }
  out.push("</body></html>");
  return out.join("\n");
}

/// The qdoc of every function in `files`, each read by `read`, the first
/// file to document a name winning. A file that cannot be read is skipped,
/// and only it: one unreadable file ended the reading, and every file after
/// it went undocumented (#1542).
export async function workspaceDocs<F>(files: readonly F[], read: (file: F) => Promise<string>): Promise<Map<string, string>> {
  const docs = new Map<string, string>();
  for (const file of files) {
    let text: string;
    try {
      text = await read(file);
    } catch {
      continue;
    }
    for (const [name, doc] of qdocs(text)) if (!docs.has(name)) docs.set(name, doc);
  }
  return docs;
}
