// Table templates (#965) and the schema diagram (#966), as data: q written
// for a table from its details, and a drawing of a process's tables with
// the columns that point from one to another. Free of any `vscode` import,
// so node tests it; `schemaview.ts` reads the process and shows them.
//
// Both work from `tableinfo.ts`'s TABLE_INFO, which reads `meta`: its `f`
// column names the table a column points into, for a foreign key (a column
// enumerated over a keyed table) and for a link column (indices into a
// table, `` `t!i ``) alike - told apart here by the column's type, a link
// being integers. SCHEMA asks for every table's details in one call; a
// table it cannot read is left out with q's error.
//
// The templates read and write nothing on their own. Select, meta and count
// by date are reads, run as the explorer's Preview is; the insert template
// is a row of typed nulls, each column enlisted, opened in an editor to
// fill in and never sent.
import { TABLE_INFO, readTableInfo, type TableInfo } from "./tableinfo";
import { qName } from "./explorer";
import { symbolLiteral } from "./qliteral";

/// The commands, as `schemaview.ts` registers them.
export const SCHEMA_COMMANDS = {
  templates: "q-lint.tableTemplates",
  diagram: "q-lint.showSchemaDiagram",
  saveSvg: "q-lint.saveSchemaDiagram",
  mermaid: "q-lint.copySchemaMermaid",
} as const;

/// The panel's view type, for `activeWebviewPanelId` in `when` clauses.
export const SCHEMA_PANEL = "q-lint.schema";

/// The settings, `q-lint.processExplorer.<feature>.enable`: each on unless
/// set to false.
export function readSchemaTools(get: <T>(key: string, fallback: T) => T): { templates: boolean; diagram: boolean } {
  return {
    templates: get<unknown>("processExplorer.tableTemplates.enable", true) !== false,
    diagram: get<unknown>("processExplorer.schemaDiagram.enable", true) !== false,
  };
}

/// Every table's details: the root namespace's and those of the root
/// namespaces not in `ex` (space separated, as the explorer's setting),
/// at most `lim` tables of `nc` columns each. A table that cannot be
/// read answers its error as a string.
export const SCHEMA = [
  "{[ex;lim;nc]",
  ` f:${TABLE_INFO.replace(/\n/g, "\n  ")};`,
  " n:(),tables`.;",
  " ns:` sv'`,'(key`)except(`$\" \" vs ex),`;",
  " n,:raze{@[{$[99h=type get x;` sv'x,'tables x;`$()]};x;{`$()}]}each ns;",
  " n:(\"j\"$lim)sublist n;",
  " (string n;{[f;c;x]@[f[;c];string x;{x}]}[f;nc]each n)}",
].join("\n");

/// Tables a diagram draws at most, and columns of each it lists.
export const SCHEMA_TABLES = 80;
export const SCHEMA_COLUMNS = 40;

export interface SchemaTable {
  name: string;
  info: TableInfo;
}

/// What SCHEMA answered: the tables read, and those that could not be,
/// with why. Throws when it is not that.
export function readSchema(raw: unknown): { tables: SchemaTable[]; failed: { name: string; error: string }[] } {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error(`the process answered something other than its tables: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const names = (Array.isArray(raw[0]) ? raw[0] : typeof raw[0] === "string" ? [raw[0]] : []).map(String);
  const infos = Array.isArray(raw[1]) ? raw[1] : [];
  const tables: SchemaTable[] = [];
  const failed: { name: string; error: string }[] = [];
  names.forEach((name, i) => {
    const got = infos[i];
    if (typeof got === "string") {
      failed.push({ name, error: got });
      return;
    }
    try {
      tables.push({ name, info: readTableInfo(got) });
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { tables, failed };
}

/// A column that points into another table.
export interface SchemaLink {
  from: string;
  column: string;
  to: string;
  kind: "foreign key" | "link";
}

/// The links among `tables`: every column whose `meta` names a table,
/// whether that table is drawn or not.
export function schemaLinks(tables: SchemaTable[]): SchemaLink[] {
  return tables.flatMap((t) =>
    t.info.columns
      .filter((c) => c.fkey !== "")
      .map((c): SchemaLink => ({ from: t.name, column: c.name, to: c.fkey, kind: /^[hij]$/.test(c.type) ? "link" : "foreign key" })),
  );
}

// A control character XML 1.0 forbids becomes U+FFFD, or the SVG will not parse.
const escape = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "\uFFFD").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CHAR = 7.2;
const LINE = 18;
const PAD = 10;
const GAP_X = 70;
const GAP_Y = 40;

interface Box {
  table: SchemaTable;
  x: number;
  y: number;
  w: number;
  h: number;
  /// The columns listed, and how many more there are.
  shown: TableInfo["columns"];
  more: number;
}

/// The diagram as SVG: a box per table, its name over its columns (keys
/// first and marked), and an arrow from each linking column to the table it
/// points into. Tables that link come first, in a grid as near square as
/// fits; every name is escaped. Colours are classes, for a stylesheet to set.
export function schemaSvg(tables: SchemaTable[], columnsShown = SCHEMA_COLUMNS): string {
  const links = schemaLinks(tables);
  const linked = new Set(links.flatMap((l) => [l.from, l.to]));
  const ordered = [...tables].sort((a, b) => Number(linked.has(b.name)) - Number(linked.has(a.name)) || a.name.localeCompare(b.name));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const boxes: Box[] = ordered.map((table) => {
    const shown = table.info.columns.slice(0, columnsShown);
    const more = Math.max(0, table.info.ncols - shown.length);
    const texts = [table.name, ...shown.map((c) => `${c.name} ${c.type}${c.fkey ? ` → ${c.fkey}` : ""}`), ...(more ? [`… ${more} more`] : [])];
    const w = Math.max(...texts.map((t) => t.length)) * CHAR + 2 * PAD + 12;
    return { table, x: 0, y: 0, w, h: (shown.length + (more ? 1 : 0) + 1) * LINE + PAD, shown, more };
  });
  // Columns as wide as their widest box, rows as tall as their tallest.
  const widths: number[] = [];
  const heights: number[] = [];
  boxes.forEach((b, i) => {
    const c = i % perRow;
    const r = Math.floor(i / perRow);
    widths[c] = Math.max(widths[c] ?? 0, b.w);
    heights[r] = Math.max(heights[r] ?? 0, b.h);
  });
  boxes.forEach((b, i) => {
    const c = i % perRow;
    const r = Math.floor(i / perRow);
    b.x = PAD + widths.slice(0, c).reduce((s, w) => s + w + GAP_X, 0);
    b.y = PAD + heights.slice(0, r).reduce((s, h) => s + h + GAP_Y, 0);
  });
  const width = Math.max(200, PAD * 2 + widths.reduce((s, w) => s + w + GAP_X, 0) - GAP_X);
  const height = Math.max(60, PAD * 2 + heights.reduce((s, h) => s + h + GAP_Y, 0) - GAP_Y);
  const byName = new Map(boxes.map((b) => [b.table.name, b]));
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" class="schema" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" font-family="monospace" font-size="12">`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="arrowhead" d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>',
  ];
  for (const b of boxes) {
    const kind = b.table.info.kind;
    out.push(`<g class="table ${kind}"><title>${escape(`${b.table.name}: ${kind}, ${b.table.info.rows === null ? "rows not counted" : `${b.table.info.rows} rows`}`)}</title>`);
    out.push(`<rect class="box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4"/>`);
    out.push(`<rect class="head" x="${b.x}" y="${b.y}" width="${b.w}" height="${LINE + 4}" rx="4"/>`);
    out.push(`<text class="name" x="${b.x + PAD}" y="${b.y + LINE - 3}">${escape(b.table.name)}</text>`);
    b.shown.forEach((c, i) => {
      const key = b.table.info.keys.includes(c.name);
      const y = b.y + LINE * (i + 2) - 2;
      out.push(
        `<text class="column${key ? " key" : ""}${c.fkey ? " fkey" : ""}" x="${b.x + PAD}" y="${y}">${escape(c.name)} <tspan class="type">${escape(c.type || " ")}${c.fkey ? escape(` → ${c.fkey}`) : ""}</tspan></text>`,
      );
    });
    if (b.more) {
      out.push(`<text class="more" x="${b.x + PAD}" y="${b.y + LINE * (b.shown.length + 2) - 2}">${escape(`… ${b.more} more`)}</text>`);
    }
    out.push("</g>");
  }
  for (const l of links) {
    const from = byName.get(l.from);
    const to = byName.get(l.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const at = from.shown.findIndex((c) => c.name === l.column);
    const y1 = at < 0 ? from.y + LINE / 2 : from.y + LINE * (at + 2) - 6;
    const y2 = to.y + LINE / 2;
    // From the side of the column's box that faces the target's.
    const right = to.x + to.w / 2 >= from.x + from.w / 2;
    const x1 = right ? from.x + from.w : from.x;
    let x2 = right ? to.x : to.x + to.w;
    if (from === to) {
      x2 = from.x + from.w;
    }
    const bend = from === to ? 40 : Math.max(30, Math.abs(x2 - x1) / 2);
    const c1 = right || from === to ? x1 + bend : x1 - bend;
    const c2 = from === to ? x2 + bend : right ? x2 - bend : x2 + bend;
    out.push(
      `<path class="edge ${l.kind === "link" ? "link" : "fk"}" d="M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}" fill="none" marker-end="url(#arrow)"><title>${escape(`${l.from}.${l.column} → ${l.to} (${l.kind})`)}</title></path>`,
    );
  }
  out.push("</svg>");
  return out.join("\n");
}

/// The diagram as Mermaid's erDiagram text, to paste into Markdown.
export function schemaMermaid(tables: SchemaTable[]): string {
  const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  const lines = ["erDiagram"];
  for (const t of tables) {
    lines.push(`  ${id(t.name)} {`);
    for (const c of t.info.columns) {
      const mark = t.info.keys.includes(c.name) ? " PK" : c.fkey ? " FK" : "";
      lines.push(`    ${c.type ? id(c.type) : "any"} ${id(c.name)}${mark}`);
    }
    lines.push("  }");
  }
  for (const l of schemaLinks(tables)) {
    lines.push(`  ${id(l.to)} ||--o{ ${id(l.from)} : "${l.column.replace(/"/g, "'")}"`);
  }
  return `${lines.join("\n")}\n`;
}

/// One template for a table: its label, the code, and whether it only
/// reads (and so runs when picked) or is to be filled in (and opens in an
/// editor).
export interface TableTemplate {
  label: string;
  detail: string;
  code: string;
  runs: boolean;
}

/// Each type letter's null, as an insert template's placeholder.
const NULL_OF: Record<string, string> = {
  b: "0b", g: "0Ng", x: "0x00", h: "0Nh", i: "0Ni", j: "0Nj", e: "0Ne", f: "0n", c: '" "', s: "`",
  p: "0Np", m: "0Nm", d: "0Nd", z: "0Nz", n: "0Nn", u: "0Nu", v: "0Nv", t: "0Nt", C: '""',
};

/// The templates for table `name`, given its details. `limit`: the rows
/// Select first takes.
export function tableTemplates(name: string, info: TableInfo, limit = 100): TableTemplate[] {
  const t = qName(name);
  const partitioned = info.kind === "partitioned";
  // A partitioned table's first column is its partition field.
  const field = partitioned ? info.columns[0]?.name : undefined;
  const out: TableTemplate[] = [
    {
      label: `Select first ${limit}`,
      detail: partitioned ? `from the last ${field ?? "partition"} only` : "the first rows",
      // `select[n]` of a partitioned table is 'nyi on kdb+: `i` counts in
      // each partition, and only the last is read.
      code: partitioned && field !== undefined ? `select from ${t} where ${field}=last ${field}, i<${limit}` : `select[${limit}] from ${t}`,
      runs: true,
    },
    { label: "meta", detail: "its columns, types, foreign keys and attributes", code: `meta ${t}`, runs: true },
  ];
  const date = partitioned && field !== undefined ? { by: field, code: field } : undefined;
  const dated = date ?? (() => {
    const d = info.columns.find((c) => c.type === "d");
    if (d !== undefined) {
      return { by: d.name, code: d.name };
    }
    const stamp = info.columns.find((c) => c.type === "p" || c.type === "z");
    return stamp === undefined ? undefined : { by: "date", code: `${stamp.name}.date` };
  })();
  if (dated !== undefined) {
    const by = dated.by === dated.code ? dated.by : `${dated.by}:${dated.code}`;
    out.push({ label: "Count by date", detail: `rows per ${dated.by === dated.code ? dated.by : `date of ${dated.code.replace(/\.date$/, "")}`}`, code: `select count i by ${by} from ${t}`, runs: true });
  }
  if (!partitioned && info.kind !== "splayed" && info.columns.length > 0 && info.columns.length === info.ncols) {
    // Each column enlisted: one row, whatever the column holds.
    const width = Math.max(...info.columns.map((c) => (NULL_OF[c.type] ?? "()").length)) + 8;
    const rows = info.columns.map((c, i) => {
      const value = `enlist ${NULL_OF[c.type] ?? "()"}${i === info.columns.length - 1 ? ")" : ";"}`;
      // A foreign key takes a key of its table: a null is not one.
      return `  ${value.padEnd(width)} / ${c.name}${c.type ? ` (${c.type})` : ""}${info.keys.includes(c.name) ? ", key" : ""}${c.fkey ? `, a key of ${c.fkey}` : ""}`;
    });
    out.push({
      label: "Insert template",
      detail: "a row of typed nulls to fill in, opened in an editor",
      code: [`/ One row for ${name}: replace each null, then run the statement.`, `${symbolLiteral(name)} insert (`, ...rows, ""].join("\n"),
      runs: false,
    });
  }
  return out;
}
