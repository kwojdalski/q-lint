// The q the Data Wrangler (#961), data files (#962), the CSV load wizard
// (#963), cell edits (#964), table templates (#965) and the schema diagram
// (#966) write, run on a real q process: what each answers, and what each
// changes. Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const w = require("../out/wrangle.js");
const d = require("../out/datafile.js");
const s = require("../out/schema.js");
const { TABLE_INFO, readTableInfo } = require("../out/tableinfo.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 200];

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-data-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source(dir));
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, cwd: dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (up) {
      return {
        dir,
        port,
        stop: () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        },
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(-child.pid, "SIGKILL");
  throw new Error("q did not start listening");
}

// A keyed table, a table with a foreign key into it, one with a link column,
// a table in a namespace, a foreign key over a long key there, and an HDB of
// two date partitions.
const SERVER = (dir) => `
{[d] .Q.dd[hsym \`$"${dir}/hdb";d,\`p\`] set .Q.en[hsym \`$"${dir}/hdb"] ([] sym:\`a\`b\`c; px:1 2 3f)} each 2026.01.01 2026.01.02;
\\l ${dir}/hdb
s:([sym:\`a\`b\`c] nm:("Aa";"Bb";"Cc"));
t:([] time:2026.01.01D10:00 2026.01.02D11:00 2026.01.02D12:00; sym:\`s$\`a\`b\`a; px:1.5 0n 2.5; qty:1 2 3; note:("x y";enlist"z";"w"));
u:([] x:1 2; l:\`t!0 2);
.ns.v:([] a:1 2);
.ns.k:([k:1 2 3] w:10 20 30);
.ns.f:([] c:\`.ns.k$1 2 2);
`;

const cells = (answer, name) => answer.grid.cells[answer.grid.names.indexOf(name)];

test("the q of the data tools against a real q process", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  const grid = async (code) => {
    const answer = await connection.queryGrid(statements(code), SIZE, 1000);
    assert.ok(answer.ok, `${code}: ${answer.error}`);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.ok(answer.grid !== undefined, `${code}: not tabular: ${answer.text}`);
    return answer;
  };
  const run = async (code) => {
    const answer = await connection.query(statements(code), SIZE);
    assert.ok(answer.ok, `${code}: ${answer.error}`);
    return answer;
  };
  const text = async (code) => [].concat((await run(code)).text).join("\n");

  await t.test("SCHEMA reads every table, and meta finds the foreign key and the link (#966)", async () => {
    const { tables, failed } = s.readSchema(await connection.call(s.SCHEMA, "q Q h j o s", s.SCHEMA_TABLES, s.SCHEMA_COLUMNS));
    assert.deepStrictEqual(failed, []);
    for (const name of ["p", "s", "t", "u", ".ns.v"]) {
      assert.ok(tables.some((x) => x.name === name), name);
    }
    assert.strictEqual(tables.find((x) => x.name === "p").info.kind, "partitioned");
    const links = s.schemaLinks(tables).map((l) => `${l.from}.${l.column}->${l.to} ${l.kind}`);
    // `meta` shows `j` for the key over longs as for the link (#1957).
    assert.deepStrictEqual(links.sort(), [".ns.f.c->.ns.k foreign key", "t.sym->s foreign key", "u.l->t link"]);
    assert.match(s.schemaSvg(tables), /class="edge link"/);
  });

  await t.test("each template runs, and the insert template filled in adds a row (#965)", async () => {
    for (const name of ["t", "s", "p", ".ns.v"]) {
      const info = readTableInfo(await connection.call(TABLE_INFO, name, 500));
      for (const tpl of s.tableTemplates(name, info)) {
        if (tpl.runs) {
          await grid(tpl.code);
        }
      }
    }
    const info = readTableInfo(await connection.call(TABLE_INFO, "t", 500));
    const insert = s.tableTemplates("t", info).find((x) => !x.runs);
    assert.deepStrictEqual(s.tableTemplates("p", readTableInfo(await connection.call(TABLE_INFO, "p", 500))).map((x) => x.label), ["Select first 100", "meta", "Count by date"]);
    // The template filled in inserts a row: the foreign key needs a key of
    // s (PeachQ refuses a null there), the rest can stay null.
    assert.match(insert.code, /enlist `; {3}\/ sym \(s\), a key of s\n/);
    await run(insert.code.replace("enlist `;", "enlist `a;"));
    assert.strictEqual(await text("count t"), "4");
    await run("delete from `t where null time");
    const byDate = await grid(s.tableTemplates("t", info).find((x) => x.label === "Count by date").code);
    assert.deepStrictEqual(cells(byDate, "x"), ["1", "2"]);
    const last = await grid(s.tableTemplates("p", readTableInfo(await connection.call(TABLE_INFO, "p", 500)))[0].code);
    assert.deepStrictEqual(cells(last, "date"), ["2026.01.02", "2026.01.02", "2026.01.02"]);
  });

  await t.test("every filter offered on a column of strings runs, and keeps the rows it says (#2014)", async () => {
    const from = '([] a:3 1 2 4; b:("xy";"yy";"";enlist"x"))';
    const base = await grid(from);
    const strings = w.stringColumn(base.grid, 1);
    assert.strictEqual(strings, true);
    const kept = async (op, value) => cells(await grid(w.wrangleQuery(from, [{ kind: "filter", column: "b", op, value, strings }])), "a");
    // The value the filter starts from is the first cell's, as the view fills it in.
    const first = w.cellLiteral(base.grid, 1, 0);
    const answers = {};
    for (const op of w.filterOps(strings)) answers[op] = await kept(op, op === "in" ? '("yy";"xy")' : op === "like" ? '"?y"' : first);
    assert.deepStrictEqual(answers, { "=": ["3"], "<>": ["1", "2", "4"], like: ["3", "1"], in: ["3", "1"], null: ["2"], "not null": ["3", "1", "4"] });
    assert.deepStrictEqual(await kept("=", w.cellLiteral(base.grid, 1, 3)), ["4"]);
    // The ordering tests are q's 'length on strings: they are not offered.
    const answer = await connection.queryGrid(statements(w.wrangleQuery(from, [{ kind: "filter", column: "b", op: "<", value: first }])), SIZE, 1000);
    assert.deepStrictEqual([answer.ok, answer.error], [false, "length"]);
  });

  await t.test("a wrangle's steps run as one expression, and change nothing on the process (#961)", async () => {
    const base = await grid("select from t");
    const steps = [
      { kind: "filter", column: "px", op: "not null", value: "" },
      { kind: "sort", column: "px", descending: true },
      { kind: "rename", column: "px", to: "price" },
      { kind: "cast", column: "qty", to: "f" },
      { kind: "drop", column: "note" },
    ];
    const out = await grid(w.wrangleQuery("select from t", steps));
    assert.deepStrictEqual(out.grid.names, ["time", "sym", "price", "qty"]);
    assert.deepStrictEqual(cells(out, "price"), ["2.5", "1.5"]);
    assert.strictEqual(out.grid.types[3], 9);
    const parsed = await grid(w.wrangleQuery("([] s:(\"1\";\"22\"))", [{ kind: "cast", column: "s", to: "j", strings: w.stringColumn(base.grid, 4) }]));
    assert.strictEqual(parsed.grid.types[0], 7);
    // A column of strings cast to strings stays as it was, not split into characters (#1281).
    const same = await grid(w.wrangleQuery("([] s:(\"1\";\"22\"))", [{ kind: "cast", column: "s", to: "*", strings: true }]));
    assert.deepStrictEqual(cells(same, "s"), [',"1"', '"22"']);
    // The script form gives the same table, and assigns nothing.
    const script = w.wrangleScript("select from t", steps, "test");
    const viaScript = await grid(script);
    assert.deepStrictEqual(viaScript.grid.cells, out.grid.cells);
    assert.strictEqual(await text("`w in key`."), "0b");
    assert.strictEqual(await text("count t"), "3");
  });

  // The grid shows a partitioned table by row index; a sort, a cast, a drop
  // or a rename of it would read every partition into memory, so the q sent
  // refuses it, naming the fix: a filter first (#2147).
  await t.test("a wrangle refuses a sort, cast, drop or rename of a partitioned table before a filter (#2147)", async () => {
    for (const step of [
      { kind: "sort", column: "px", descending: true },
      { kind: "cast", column: "px", to: "j", type: 9 },
      { kind: "drop", column: "px" },
      { kind: "rename", column: "px", to: "price" },
    ]) {
      const answer = await connection.queryGrid(statements(w.wrangleQuery("p", [step])), SIZE, 1000);
      assert.strictEqual(answer.ok, false, step.kind);
      assert.match(answer.error, /^a partitioned table: filter it first, on date for one, so that only the partitions it keeps are read/, step.kind);
      const script = await connection.queryGrid(statements(w.wrangleScript("p", [step], "test")), SIZE, 1000);
      assert.match(script.error ?? "", /^a partitioned table: filter it first, on date/, step.kind);
    }
    // A filter first reads only the partitions it keeps; every step after works.
    const steps = [
      { kind: "filter", column: "date", op: "=", value: "2026.01.02" },
      { kind: "sort", column: "px", descending: true },
      { kind: "rename", column: "px", to: "price" },
      { kind: "cast", column: "price", to: "j", type: 9 },
      { kind: "drop", column: "sym" },
    ];
    const kept = w.wrangleQuery("p", steps);
    assert.doesNotMatch(kept, /qp/);
    const out = await grid(kept);
    assert.deepStrictEqual([out.grid.names, cells(out, "price"), cells(out, "date"), out.grid.types[1]], [["date", "price"], ["3", "2", "1"], ["2026.01.02", "2026.01.02", "2026.01.02"], 7]);
    assert.deepStrictEqual((await grid(w.wrangleScript("p", steps, "test"))).grid.cells, out.grid.cells);
    // A table in memory read by its name passes through the check.
    assert.deepStrictEqual((await grid(w.wrangleQuery("t", [{ kind: "drop", column: "note" }]))).grid.names, ["time", "sym", "px", "qty"]);
    assert.strictEqual(await text(".Q.qp p"), "1b");
  });

  await t.test("a cell edit changes the one row it was made in: a null, a string and an enumeration found (#964)", async () => {
    const before = await grid("t");
    // Row 1: px is null, note a one-character string, sym enumerated.
    const edit = w.editStatement(before.grid, 2, 1, w.guessTable("t"), "9.5");
    await run(edit.code);
    let after = await grid("t");
    assert.deepStrictEqual(cells(after, "px"), ["1.5", "9.5", "2.5"]);
    const edited = w.editStatement(after.grid, 4, 0, "t", '"edited"');
    await run(edited.code);
    after = await grid("t");
    assert.deepStrictEqual(cells(after, "note"), ['"edited"', ',"z"', '"w"']);
    // A keyed table's row is found by its key.
    const keyed = await grid("s");
    await run(w.editStatement(keyed.grid, 1, 2, "s", '"Cee"').code);
    assert.deepStrictEqual(cells(await grid("s"), "nm"), ['"Aa"', '"Bb"', '"Cee"']);
  });

  await t.test("a data file loads by its path and from its text, with the types guessed or chosen (#962, #963)", async () => {
    const csv = path.join(q.dir, "my trades.csv");
    const text = 'sym,px,qty,d,ts,note\nAAPL,1.5,10,2024-01-02,2024-01-02T10:00:00.123,"hello, world"\nMSFT,2.25,,2024.01.03,2024-01-03 11:00:00,plain\n';
    fs.writeFileSync(csv, text);
    const sample = d.sampleText(text);
    assert.deepStrictEqual(sample.types, ["S", "F", "J", "D", "P", "*"]);
    for (const local of [true, false]) {
      const out = await grid(d.loadExpression("csv", csv, local, sample, local ? undefined : text));
      assert.deepStrictEqual(out.grid.names, ["sym", "px", "qty", "d", "ts", "note"]);
      assert.deepStrictEqual(out.grid.types, [11, 9, 7, 14, 12, 0]);
      assert.deepStrictEqual(cells(out, "note"), ['"hello, world"', '"plain"']);
      assert.deepStrictEqual(cells(out, "qty"), ["10", ""]);
    }
    // The wizard: qty as a float, note skipped, assigned to a name.
    await run(`loaded:${d.csvLoad(["S", "F", "F", "D", "P", " "], ",", d.fileHandle(csv))}`);
    const loaded = await grid("loaded");
    assert.deepStrictEqual(loaded.grid.names, ["sym", "px", "qty", "d", "ts"]);
    assert.strictEqual(loaded.grid.types[2], 9);
    const tsv = path.join(q.dir, "t.tsv");
    fs.writeFileSync(tsv, "a\tb\nx\t1\ny\t2\n");
    const tsvOut = await grid(d.loadExpression("csv", tsv, true, d.sampleText(fs.readFileSync(tsv, "utf8"), "\t")));
    assert.deepStrictEqual(tsvOut.grid.types, [11, 7]);
    const json = path.join(q.dir, "t.json");
    fs.writeFileSync(json, '[{"a":1,"b":"x"},\n{"a":2,"b":"y"}]\n');
    for (const local of [true, false]) {
      const out = await grid(d.loadExpression("json", json, local, { types: [], delimiter: "" }, fs.readFileSync(json, "utf8")));
      assert.deepStrictEqual(out.grid.names, ["a", "b"]);
      assert.deepStrictEqual(cells(out, "a"), ["1", "2"]);
    }
  });

  await t.test("a CSV that starts with a byte order mark loads with the names its sample showed, by its path as from its text (#1966)", async () => {
    const csv = path.join(q.dir, "excel.csv");
    for (const [text, names] of [["\ufeffa,b\n1,2\n", ["a", "b"]], ['\ufeff"a",b\n1,2\n', ["a", "b"]], ["\ufeffa\n1\n", ["a"]]]) {
      fs.writeFileSync(csv, text);
      const sample = d.sampleText(text);
      assert.deepStrictEqual([sample.names, sample.bom], [names, true]);
      for (const local of [true, false]) {
        const out = await grid(d.loadExpression("csv", csv, local, sample, local ? undefined : text));
        assert.deepStrictEqual([out.grid.names, cells(out, "a")], [names, ["1"]], `${JSON.stringify(text)} ${local}`);
      }
      // The wizard's statement, its first column kept or skipped.
      await run(`marked:${d.csvLoad(sample.types, ",", d.fileSource(csv, sample.bom))}`);
      assert.deepStrictEqual((await grid("select a from marked")).grid.names, ["a"]);
      if (names.length > 1) {
        await run(`marked:${d.csvLoad([" ", "J"], ",", d.fileSource(csv, sample.bom))}`);
        assert.deepStrictEqual((await grid("marked")).grid.names, ["b"]);
      }
    }
    // The mark gone from the file since it was sampled: the statement still loads it.
    fs.writeFileSync(csv, "a,b\n1,2\n");
    assert.deepStrictEqual((await grid(d.loadExpression("csv", csv, true, { types: ["J", "J"], delimiter: ",", bom: true }))).grid.names, ["a", "b"]);
  });

  // .j.k refuses a byte order mark, by the file's path and from its text (#2448).
  await t.test("a JSON file that starts with a byte order mark loads by its path and from its bytes (#2448)", async () => {
    const json = path.join(q.dir, "bom.json");
    fs.writeFileSync(json, '\ufeff[{"a":1,"b":"x"}]\n');
    for (const local of [true, false]) {
      const out = await grid(d.loadExpression("json", json, local, { types: [], delimiter: "" }, local ? undefined : fs.readFileSync(json)));
      assert.deepStrictEqual([out.grid.names, cells(out, "a")], [["a", "b"], ["1"]], `local ${local}`);
    }
  });

  // A file read as UTF-8 for a remote process had each Latin-1 byte made
  // U+FFFD, where a load by its path keeps the byte (#2468).
  await t.test("a Latin-1 CSV loads byte for byte from its bytes as by its path (#2468)", async () => {
    const csv = path.join(q.dir, "latin1.csv");
    const bytes = Buffer.from("city,n\r\nZ\xfcrich,1\r\nK\xf6ln,2\r\na\\b\xe9,3\n", "latin1");
    fs.writeFileSync(csv, bytes);
    const sample = { ...d.sampleText(bytes.toString("utf8")), types: ["*", "J"] };
    for (const local of [true, false]) {
      await run(`lat:${d.loadExpression("csv", csv, local, sample, local ? undefined : fs.readFileSync(csv))}`);
      assert.strictEqual(await text('(lat`city)~("Z\\374rich";"K\\366ln";"a\\\\b\\351")'), "1b", `local ${local}`);
    }
  });

  await t.test("a one-column CSV loads by its path and from its text, its one-character lines too (#1262)", async () => {
    const csv = path.join(q.dir, "one.csv");
    const text = "x\n1\n22\n";
    fs.writeFileSync(csv, text);
    const sample = d.sampleText(text);
    assert.deepStrictEqual(sample.types, ["J"]);
    for (const local of [true, false]) {
      const out = await grid(d.loadExpression("csv", csv, local, sample, local ? undefined : text));
      assert.deepStrictEqual(out.grid.names, ["x"]);
      assert.deepStrictEqual(cells(out, "x"), ["1", "22"]);
    }
    const header = await grid(d.loadExpression("csv", csv, false, sample, "x\n"));
    assert.deepStrictEqual(header.grid.names, ["x"]);
  });
});

test("Count by date runs on a table whose date or timestamp column is no q name (#2536)", { skip }, async (t) => {
  const q = await startQ(() => [
    'ts:flip(`$"trade date";`px)!(2026.01.01 2026.01.02 2026.01.02;1 2 3f)',
    'tp:flip(`$"trade time";`px)!(2026.01.01D10:00 2026.01.02D11:00 2026.01.02D12:00;1 2 3f)',
    "",
  ].join("\n"));
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  for (const name of ["ts", "tp"]) {
    const tpl = s.tableTemplates(name, readTableInfo(await connection.call(TABLE_INFO, name, 500))).find((x) => x.label === "Count by date");
    const answer = await connection.queryGrid(statements(tpl.code), SIZE, 1000);
    assert.ok(answer.ok, `${tpl.code}: ${answer.error}`);
    assert.deepStrictEqual(cells(answer, "x"), ["1", "2"], tpl.code);
    assert.deepStrictEqual(answer.grid.cells[0], ["2026.01.01", "2026.01.02"], tpl.code);
  }
});

test("Show steps as q runs when the wrangled query reads a global named w (#2466)", { skip }, async (t) => {
  const q = await startQ(() => "w:([] a:1 2 3)\nw1:`x\n");
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  const steps = [{ kind: "filter", column: "a", op: ">", value: "1" }];
  for (const base of ["w", "select from w where a in exec a from w"]) {
    const answer = await connection.queryGrid(statements(w.wrangleScript(base, steps, "test")), SIZE, 1000);
    assert.ok(answer.ok, `${base}: ${answer.error}`);
    assert.deepStrictEqual(cells(answer, "a"), ["2", "3"]);
  }
});

test("a general cell's new value is one item: a join adds no column, and :: is the generic null (#3078, #3079)", { skip }, async (t) => {
  const q = await startQ(() => 'tt:([] id:1 2 3; s:("ab";"cd";"ef"))\ng:([] id:1 2 3; g:(1;`a;"s"))\n');
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  const shown = async (table) => (await connection.queryGrid(statements(table), SIZE, 1000)).grid;
  const edit = async (table, row, value) => {
    const edited = w.editStatement(await shown(table), 1, row, table, value);
    const answer = await connection.query(statements(edited.code), SIZE);
    assert.ok(answer.ok, `${edited.code}: ${answer.error}`);
  };
  await edit("tt", 0, '"x","y"');
  let after = await shown("tt");
  assert.deepStrictEqual([after.names, after.cells[1]], [["id", "s"], ['"xy"', '"cd"', '"ef"']]);
  await edit("g", 1, "1,2");
  await edit("g", 0, "::");
  after = await shown("g");
  assert.deepStrictEqual([after.names, after.cells[1]], [["id", "g"], ["::", "1 2", '"s"']]);
});

test("a one-character value typed into a column of strings is stored as a string (#3080)", { skip }, async (t) => {
  const q = await startQ(() => 'tt:([] id:1 2 3; s:("ab";"cd";"ef"))\n');
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  const shown = async (code) => (await connection.queryGrid(statements(code), SIZE, 1000)).grid;
  const edited = w.editStatement(await shown("tt"), 1, 0, "tt", '"x"');
  const answer = await connection.query(statements(edited.code), SIZE);
  assert.ok(answer.ok, `${edited.code}: ${answer.error}`);
  assert.deepStrictEqual((await shown("tt")).cells[1], [',"x"', '"cd"', '"ef"']);
  assert.deepStrictEqual((await shown("([] t:type each tt`s)")).cells[0], ["10", "10", "10"]);
});
