// Table templates (#965) and the schema diagram (#966), src/schema.ts: the
// templates' q, the links found, the SVG and Mermaid drawn, without q.
// datatools_q.test.js runs the q on a real process.
const test = require("node:test");
const assert = require("node:assert");
const s = require("../out/schema.js");

const info = (over = {}) => ({
  kind: "table",
  rows: 3,
  bytes: 100,
  partitions: null,
  keys: [],
  ncols: 3,
  columns: [
    { name: "time", type: "p", fkey: "", attr: "" },
    { name: "sym", type: "s", fkey: "", attr: "g" },
    { name: "note", type: "C", fkey: "", attr: "" },
  ],
  ...over,
});

test("table templates: select first, meta, count by date and an insert of typed nulls (#965)", () => {
  const t = s.tableTemplates("trade", info());
  assert.deepStrictEqual(t.map((x) => [x.label, x.runs]), [["Select first 100", true], ["meta", true], ["Count by date", true], ["Insert template", false]]);
  assert.strictEqual(t[0].code, "select[100] from trade");
  assert.strictEqual(t[1].code, "meta trade");
  assert.strictEqual(t[2].code, "select count i by date:time.date from trade");
  assert.strictEqual(t[3].code, "/ One row for trade: replace each null, then run the statement.\n`trade insert (\n  enlist 0Np; / time (p)\n  enlist `;   / sym (s)\n  enlist \"\")  / note (C)\n");
  const part = s.tableTemplates("quote", info({ kind: "partitioned", columns: [{ name: "date", type: "d", fkey: "", attr: "" }, ...info().columns] }));
  assert.deepStrictEqual(part.map((x) => x.code), ["select from quote where date=last date, i<100", "meta quote", "select count i by date from quote"]);
  const plain = s.tableTemplates("kv", info({ kind: "keyed", keys: ["k"], ncols: 2, columns: [{ name: "k", type: "j", fkey: "", attr: "" }, { name: "v", type: "", fkey: "", attr: "" }] }));
  assert.deepStrictEqual(plain.map((x) => x.label), ["Select first 100", "meta", "Insert template"]);
  assert.match(plain[2].code, /enlist 0Nj; \/ k \(j\), key\n {2}enlist \(\)\) {2}\/ v/);
  assert.strictEqual(s.tableTemplates("a b", info())[0].code, 'select[100] from get`$"a b"');
  // Parenthesised: `$"a b" insert (...) is `$("a b" insert ...) (#1570).
  assert.match(s.tableTemplates("a b", info())[3].code, /\n\(`\$"a b"\) insert \(\n/);
});

test("the insert template keeps a name holding a line break inside its / comment (#3055)", () => {
  const evil = "note\n.z.pw:{[u;p]1b};1";
  const odd = info({ kind: "table", ncols: 2, columns: [{ name: evil, type: "s", fkey: evil, attr: "" }, { name: "px", type: "f", fkey: "", attr: "" }] });
  const code = s.tableTemplates(evil, odd).find((x) => x.label === "Insert template").code;
  assert.ok(code.split("\n").every((line) => !line.startsWith(".z.pw")), code);
  assert.match(code, /^\/ One row for note\\n\.z\.pw:\{\[u;p\]1b\};1: replace each null/);
  assert.match(code, /\n {2}enlist `; +\/ note\\n\.z\.pw:\{\[u;p\]1b\};1 \(s\), a key of note\\n\.z\.pw:\{\[u;p\]1b\};1\n/);
});

const tables = [
  { name: "s", info: info({ kind: "keyed", keys: ["sym"], ncols: 2, columns: [{ name: "sym", type: "s", fkey: "", attr: "u" }, { name: "nm", type: "C", fkey: "", attr: "" }] }) },
  { name: "t", info: info({ columns: [{ name: "sym", type: "s", fkey: "s", attr: "" }, { name: "px", type: "f", fkey: "", attr: "" }], ncols: 2 }) },
  { name: "u<x>", info: info({ columns: [{ name: "l", type: "j", fkey: "t", attr: "" }, { name: "o", type: "s", fkey: "gone", attr: "" }], ncols: 5 }) },
];

test("the schema diagram: foreign keys and links found by meta, every name escaped, and Mermaid text (#966)", () => {
  assert.deepStrictEqual(s.schemaLinks(tables), [
    { from: "t", column: "sym", to: "s", kind: "foreign key" },
    { from: "u<x>", column: "l", to: "t", kind: "link" },
    { from: "u<x>", column: "o", to: "gone", kind: "foreign key" },
  ]);
  // A foreign key over a long key has a link's type letter: the keyed table
  // it points into tells them apart, as does a plain one for a link (#1957).
  const kt = { name: "kt", info: info({ kind: "keyed", keys: ["k"], ncols: 2, columns: [{ name: "k", type: "j", fkey: "", attr: "" }, { name: "v", type: "j", fkey: "", attr: "" }] }) };
  const lk = { name: "lk", info: info({ ncols: 3, columns: [{ name: "c", type: "j", fkey: "kt", attr: "" }, { name: "h", type: "h", fkey: "kt", attr: "" }, { name: "r", type: "j", fkey: "lk", attr: "" }] }) };
  assert.deepStrictEqual(s.schemaLinks([kt, lk]).map((l) => `${l.column} ${l.kind}`), ["c foreign key", "h foreign key", "r link"]);
  assert.deepStrictEqual(s.schemaLinks([lk]).map((l) => l.kind), ["link", "link", "link"]);
  const svg = s.schemaSvg(tables);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="schema"/);
  assert.ok(!svg.includes("u<x>"), "a name is escaped");
  assert.match(svg, /u&#60;x&#62;/);
  // An edge per link drawn; none into a table not drawn.
  assert.strictEqual((svg.match(/<path class="edge/g) ?? []).length, 2);
  assert.match(svg, /class="edge link"/);
  assert.match(svg, /… 3 more/);
  assert.match(svg, /class="column key"/);
  assert.strictEqual((svg.match(/<g class="table/g) ?? []).length, 3);
  assert.strictEqual(s.schemaSvg([]).includes("<g"), false);
  const mermaid = s.schemaMermaid(tables);
  assert.match(mermaid, /^erDiagram\n {2}s \{\n {4}s sym PK\n {4}C nm\n {2}\}/);
  assert.match(mermaid, / {2}s \|\|--o\{ t : "sym"/);
  assert.match(mermaid, / {2}t \|\|--o\{ u_x_ : "l"/);
  // SCHEMA's answer: names and details, or an error per table.
  const raw = [["s", "bad"], [{ kind: "keyed", rows: 1, bytes: 1, partitions: null, keys: ["sym"], ncols: 1, cols: ["sym"], types: ["s"], fkeys: [""], attrs: [""] }, "type"]];
  const read = s.readSchema(raw);
  assert.deepStrictEqual(read.tables.map((x) => x.name), ["s"]);
  assert.deepStrictEqual(read.failed, [{ name: "bad", error: "type" }]);
  assert.throws(() => s.readSchema({}), /something other than its tables/);
  assert.match(s.SCHEMA, /^\{\[ex;lim;nc\]/);
});

test("schema diagram: a control character in a name is replaced, so the SVG still parses (#1474)", () => {
  const svg = s.schemaSvg([{ name: "fix\u0001msg", info: info({ columns: [{ name: "c\u0002", type: "s", fkey: "", attr: "" }] }) }]);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg), svg);
  assert.match(svg, /fix�msg/);
});
