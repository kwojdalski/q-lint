// Paste as q Table against a real q (#967): for random CSV and TSV text -
// longs to their ends, floats in every spelling, dates, timestamps and
// times with empty cells, symbols and strings with quotes and delimiters
// inside quoted fields - the literal pastetable.ts writes evaluates
// to the table q's own `0:` loads from the same text with the type letters
// it inferred. Lines end in \n, which read0 takes off (pastetable.test.js
// reads \r\n), and no quoted field holds a newline, which read0 would cut.
// Needs QLINT_TEST_Q, as the other real-q tests.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pasteTable, LOAD_LETTER } = require("../out/pastetable.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
const pad = (n, w = 2) => String(n).padStart(w, "0");

/// A random cell of each kind, empty one time in eight where the kind has a null.
const CELLS = {
  long: (r) => pick(r, ["0", "-1", "9223372036854775807", "-9223372036854775807", String(Math.floor((r() - 0.5) * 1e12)), String(Math.floor(r() * 1000))]),
  float: (r) => pick(r, ["1.5", "-0.25", "1e-5", "2.5E3", ".5", "3.", "100", String((r() - 0.5) * 10 ** Math.floor(r() * 30 - 10)), String(r()), "12345678901234567890", "1e300"]),
  date: (r) => {
    const sep = pick(r, ["-", "."]);
    return `${pad(1900 + Math.floor(r() * 400), 4)}${sep}${pad(1 + Math.floor(r() * 12))}${sep}${pad(1 + Math.floor(r() * 28))}`;
  },
  timestamp: (r) =>
    `${pad(1800 + Math.floor(r() * 450), 4)}-${pad(1 + Math.floor(r() * 12))}-${pad(1 + Math.floor(r() * 28))}${pick(r, [" ", "T"])}${pad(Math.floor(r() * 24))}:${pad(Math.floor(r() * 60))}:${pad(Math.floor(r() * 60))}${pick(r, ["", ".5", ".123", ".123456789"])}`,
  time: (r) => `${pad(Math.floor(r() * 24))}:${pad(Math.floor(r() * 60))}:${pad(Math.floor(r() * 60))}${pick(r, ["", ".5", ".25", ".123"])}`,
  symbol: (r) => pick(r, ["AAPL", "EUR/USD", "a.b", "x_1", "_under", "q,r", 'say "hi"', "é", "", "z"]),
  string: (r) => pick(r, ["Apple Inc", "two  spaces", "a,b", 'quote " in', "x", "", "tab\there"]),
};
const NULLABLE = new Set(["long", "float", "date", "timestamp", "time", "symbol", "string"]);

/// A field as a spreadsheet writes it: in quotes when it must be.
const field = (cell, d) => (cell.includes(d) || cell.includes('"') || cell.includes("\n") ? `"${cell.replace(/"/g, '""')}"` : cell);

test("each pasted table is the table q's 0: loads from the same text", { skip }, () => {
  const r = rng(967);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-paste-"));
  const lines = ['ck:{[i;e] r:@[value;e;{`$"error ",x}]; if[not 1b~r; -1 "FAIL ",string[i]," ",e," -> ",-3!r]}'];
  const all = [];
  for (let i = 0; i < 60; i++) {
    const d = i % 3 === 0 ? "\t" : ",";
    const kinds = Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(r, Object.keys(CELLS)));
    const n = 1 + Math.floor(r() * 6);
    // An empty cell alone on its line is a blank line, not a row.
    const rows = Array.from({ length: n }, () => kinds.map((k) => (NULLABLE.has(k) && kinds.length > 1 && r() < 0.125 ? "" : CELLS[k](r) || (kinds.length > 1 ? "" : "z"))));
    // A column of one kind keeps that kind only with one typed cell in it.
    rows[0] = kinds.map((k, c) => (rows[0][c] === "" ? CELLS[k](r) : rows[0][c]));
    const names = kinds.map((k, c) => `${k} ${c}`);
    const text = [names, ...rows].map((row) => row.map((cell) => field(cell, d)).join(d)).join("\n") + "\n";
    const got = pasteTable(text);
    assert.ok(!("error" in got), text);
    assert.strictEqual(got.header, true, text);
    assert.strictEqual(got.rows, n);
    const file = path.join(dir, `t${i}.csv`);
    fs.writeFileSync(file, text);
    // `(),` so one letter is a list, not a char.
    const letters = got.kinds.map((k) => LOAD_LETTER[k]).join("");
    all.push({ text, got });
    const load = `((),${JSON.stringify(letters)};enlist ${d === "\t" ? '"\\t"' : '","'}) 0: read0 \`$":${file}"`;
    if (got.kinds.includes("boolean")) {
      continue;
    }
    lines.push(`ck[${i};${JSON.stringify(`(value flip ${got.code})~value flip ${load}`)}]`);
  }
  // Booleans, which q's B does not read as true or false: as q's own 1b and 0b.
  const b = pasteTable("ok,n\ntrue,1\nFALSE,2\nTrue,3\n");
  assert.deepStrictEqual(b.kinds, ["boolean", "long"]);
  lines.push(`ck[1000;${JSON.stringify(`${b.code}~([] ok:101b; n:1 2 3)`)}]`);
  lines.push('-1 "DONE";', "exit 0");
  const script = path.join(dir, "paste.q");
  fs.writeFileSync(script, `${lines.join("\n")}\n`);
  const run = spawnSync(`${Q} ${script} -q`, { shell: true, encoding: "utf8", timeout: 60000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /DONE/, out.slice(0, 2000));
  const failed = out.split("\n").filter((l) => l.startsWith("FAIL"));
  assert.deepStrictEqual(failed, [], failed.map((f) => `${f}\n${JSON.stringify(all[Number(f.split(" ")[1])]?.text)}`).join("\n"));
  // Every kind was tried.
  const kinds = new Set(all.flatMap((a) => a.got.kinds));
  for (const k of ["long", "float", "date", "timestamp", "time", "symbol", "string"]) {
    assert.ok(kinds.has(k), k);
  }
});

// One spreadsheet column, its cells holding commas (#1986): the table has
// the lines of the text as its cells, as q reads them, under the header.
test("a pasted column whose cells hold commas is those cells to q, and CSV beside it is still q's 0: (#1986)", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-paste-"));
  const lines = ['ck:{[i;e] r:@[value;e;{`$"error ",x}]; if[not 1b~r; -1 "FAIL ",string[i]," ",e," -> ",-3!r]}'];
  const column = (i, text, cells) => {
    const got = pasteTable(text);
    assert.deepStrictEqual([got.names.length, got.header, got.rows], [1, true, text.trim().split("\n").length - 1], text);
    const file = path.join(dir, `c${i}.txt`);
    fs.writeFileSync(file, text);
    lines.push(`ck[${i};${JSON.stringify(`(${cells} first value flip ${got.code})~1_read0 \`$":${file}"`)}]`);
  };
  column(0, "name\nSmith, John\nDoe, Jane\n", "");
  column(1, "v\n1,234\n5,678\n", "string");
  column(2, "address\n1 Main St, Springfield\n22 Oak Ave, Apt 4, Boston\n", "");
  // CSV of the same cells, quoted as CSV writes them: two columns, as 0: loads it.
  const csv = 'name,city\n"Smith, John","Austin, TX"\n"Doe, Jane",Boston\n';
  const got = pasteTable(csv);
  assert.deepStrictEqual([got.names, got.kinds, got.rows], [["name", "city"], ["string", "string"], 2]);
  const file = path.join(dir, "t.csv");
  fs.writeFileSync(file, csv);
  lines.push(`ck[3;${JSON.stringify(`${got.code}~("**";enlist ",") 0: read0 \`$":${file}"`)}]`);
  lines.push('-1 "DONE";', "exit 0");
  const script = path.join(dir, "paste.q");
  fs.writeFileSync(script, `${lines.join("\n")}\n`);
  const run = spawnSync(`${Q} ${script} -q`, { shell: true, encoding: "utf8", timeout: 60000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /DONE/, out.slice(0, 2000));
  assert.deepStrictEqual(out.split("\n").filter((l) => l.startsWith("FAIL")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
