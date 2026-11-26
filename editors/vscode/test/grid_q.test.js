// Grid and chart mode's lambda (`GRID`, src/grid.ts) against a real q
// process: the shapes a result can take that only q can show. Needs a q
// binary, so it runs only when QLINT_TEST_Q names one, as qclient.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];
/// The token a result is held under for paging (#2128).
const TOKEN = "0123456789abcdef0123456789abcdef";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// Start q on `source(dir)`, a script written in a fresh directory, on a
/// free port; resolves once it accepts.
async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-grid-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source(dir));
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, cwd: dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      return {
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

// An HDB of two date partitions, loaded as an HDB process loads it.
const SERVER = (dir) => `
{[d] .Q.dd[hsym \`$"${dir}/hdb";d,\`p\`] set .Q.en[hsym \`$"${dir}/hdb"] ([] sym:\`a\`b\`c; px:1 2 3f)} each 2026.01.01 2026.01.02;
\\l ${dir}/hdb
strs:([] s:(250#"a";"b\\"c\\n";"caf\\303\\251";enlist "x";""))
st:([] time:09:00 09:01 09:02; px:1 2 3f; sym:\`a\`b\`c)
skt:([k:1 3 5; j:\`x\`y\`z] v:10 30 50)
sd:1 3 5!10 30 50
sdt:([] a:1 2)!([] b:3 4)
sl:10 20 30
`;

test("the grid lambda against a real q process", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());

  await t.test("a partitioned table queried by name is shown, cut as a select is", async () => {
    const answer = await connection.queryGrid(statements("p"), SIZE, 4);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.deepStrictEqual(answer.grid.names, ["date", "sym", "px"]);
    assert.strictEqual(answer.grid.count, 6);
    assert.deepStrictEqual(answer.grid.cells[1], ["a", "b", "c", "a"]);
    const last = await connection.queryGrid(statements("p"), SIZE, -2);
    assert.deepStrictEqual(last.grid.cells[0], ["2026.01.02", "2026.01.02"]);
    assert.deepStrictEqual(last.grid.cells[1], ["b", "c"]);
    const all = await connection.queryGrid(statements("p"), SIZE, Infinity);
    assert.strictEqual(all.grid.cells[0].length, 6);
  });

  await t.test("a string column's cells are not cut at the process's console width", async () => {
    const answer = await connection.queryGrid(statements("strs"), SIZE, 10);
    const cells = answer.grid.cells[0];
    // Cut at 200 characters, as the cell's text is, not at \\c's 80.
    assert.strictEqual(cells[0], `"${"a".repeat(196)}...`);
    // Escaped as q writes them, one character with its comma.
    const own = (await connection.query(statements('-3!\'1_strs`s'), [25, 2000])).text.join("");
    assert.deepStrictEqual(cells.slice(1), ['"b\\"c\\n"', '"caf\\303\\251"', ',"x"', '""'], own);
  });

  await t.test("a string column exported as JSON is read back by q as the strings it held, one of a single character too (#1961)", async () => {
    const { exportResult } = require("../out/resultexport.js");
    const grid = (await connection.queryGrid(statements("1_strs"), SIZE, 10)).grid;
    const json = exportResult("json", grid, -1).data.toString("utf8");
    assert.deepStrictEqual(JSON.parse(json).map((r) => r.s), ['b"c\n', "café", "x", ""]);
    const same = await connection.query(statements(`(1_strs)~{([] s:{$[10h=type x;x;enlist x]} each x\`s)} .j.k ${JSON.stringify(json)}`), SIZE);
    assert.deepStrictEqual(same.text, ["1b"], json);
  });

  await t.test("a char column's raw is its bytes, so a byte past ASCII is written back as itself (#1489)", async () => {
    const { atomLiteral } = require("../out/qliteral.js");
    const answer = await connection.queryGrid(statements('([]c:"a\\303\\251")'), SIZE, 10);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.deepStrictEqual(answer.grid.raw[0], [97, 0xc3, 0xa9]);
    assert.deepStrictEqual(answer.grid.cells[0].map((c, r) => atomLiteral(10, c, answer.grid.raw[0][r]).literal), ['"a"', '"\\303"', '"\\251"']);
  });

  await t.test("a char column's bytes past ASCII are exported as the characters they are, each its own (#1962)", async () => {
    const { exportResult } = require("../out/resultexport.js");
    const { toGrid } = require("../out/grid.js");
    const code = '([]c:" a\\"\\351\\303\\251\\377")';
    const grid = (await connection.queryGrid(statements(code), SIZE, 10)).grid;
    const bytes = (await connection.query(statements(`"j"$(${code})\`c`), SIZE)).text.join("").split(" ").map(Number);
    assert.deepStrictEqual(bytes, [32, 97, 34, 0xe9, 0xc3, 0xa9, 0xff]);
    const codes = (cells) => cells.map((c) => c.charCodeAt(0));
    assert.deepStrictEqual(codes(JSON.parse(exportResult("json", grid, -1).data.toString("utf8")).map((r) => r.c)), bytes);
    assert.deepStrictEqual(codes(toGrid(grid, -1).cells[0]), bytes);
    // The Parquet file holds each as UTF-8, and no replacement character.
    const parquet = exportResult("parquet", grid, -1).data;
    assert.ok(parquet.includes(Buffer.from("\u00e9\u00c3")) || (parquet.includes(Buffer.from("\u00e9")) && parquet.includes(Buffer.from("\u00ff"))));
    assert.ok(!parquet.includes(Buffer.from("\ufffd")));
    // Export as q is the table itself.
    const literal = exportResult("q", grid, -1).data.toString("utf8");
    assert.deepStrictEqual((await connection.query(statements(`(${code})~${literal}`), SIZE)).text, ["1b"], literal);
  });

  await t.test("a general column's float and real items come with every digit, for a literal (#1485)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const answer = await connection.queryGrid(statements("([]a:(1.23456789;`x;0n;0.1e;1 2))"), SIZE, 10);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.deepStrictEqual(answer.grid.cells[0], ["1.234568", "`x", "0n", "0.1e", "1 2"]);
    assert.strictEqual(tableLiteral(answer.grid).code, "([] a:(1.23456789f;`x;0n;0.1e;1 2))");
  });

  await t.test("a general column's float infinity is shown as q writes it, not as 0W (#1733)", async () => {
    const { toGrid } = require("../out/grid.js");
    const answer = await connection.queryGrid(statements("([]a:(0w;`a;-0we;1.5))"), SIZE, 10);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.deepStrictEqual(toGrid(answer.grid, -1).cells[0], ["0w", "`a", "-0we", "1.5"]);
    const floats = await connection.queryGrid(statements("([]a:0w -0w 1.5)"), SIZE, 10);
    assert.deepStrictEqual(toGrid(floats.grid, -1).cells[0], ["0w", "-0w", "1.5"]);
  });

  await t.test("a dictionary or a nested list comes with its tree, as unwrapped mode makes it (#928)", async () => {
    const { runUnwrapped } = require("../out/querycontrols.js");
    const { TREE_NODES } = require("../out/grid.js");
    const code = '`a`b`c!(1;"xy";(1 2;`p`q!(3 4;`z)))';
    const answer = await connection.queryGrid(statements(code), SIZE, 100, true);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    const tree = answer.grid.tree;
    // Not asked for (q-lint.results.tree.enable off, a notebook, an agent): not sent.
    const without = await connection.queryGrid(statements(code), SIZE, 100);
    assert.strictEqual(without.grid.tree, undefined);
    assert.deepStrictEqual(without.grid.cells, answer.grid.cells);
    assert.deepStrictEqual([tree.type, tree.count], [99, 3]);
    assert.deepStrictEqual(tree.children.map((c) => [c.key, c.text, c.type, c.count]), [["a", "1", -7, 1], ["b", '"xy"', 10, 2], ["c", "", 0, 2]]);
    const inner = tree.children[2].children[1];
    assert.deepStrictEqual(inner.children.map((c) => [c.key, c.text, c.type]), [["p", "", 7], ["q", "`z", -11]]);
    assert.deepStrictEqual(inner.children[0].children.map((c) => c.text), ["3", "4"]);
    // Unwrapped mode decodes the value and makes the same tree here.
    const here = await runUnwrapped(connection, [code], { size: SIZE, limit: 100, unlimited: false, grid: true });
    assert.deepStrictEqual(here.grid.tree, tree);
    // A keyed table inside is a table, marked keyed, both ways (#2503).
    const kcode = "`cfg`book!(`a`b!1 2;([sym:`EUR`GBP] px:1.1 1.3))";
    const ktree = (await connection.queryGrid(statements(kcode), SIZE, 100, true)).grid.tree;
    assert.deepStrictEqual([ktree.children[1].key, ktree.children[1].text, ktree.children[1].type, ktree.children[1].count], ["book", "keyed", 98, 2]);
    assert.deepStrictEqual((await runUnwrapped(connection, [kcode], { size: SIZE, limit: 100, unlimited: false, grid: true })).grid.tree, ktree);
    // Wide: cut to the budget at every level, and the counts say how much.
    const wide = (await connection.queryGrid(statements("10000#enlist til 100"), SIZE, 10, true)).grid.tree;
    const nodes = (n) => 1 + n.children.reduce((k, c) => k + nodes(c), 0);
    assert.strictEqual(nodes(wide), TREE_NODES);
    assert.strictEqual(wide.count, 10000);
    // A table, a keyed table and a simple list have none.
    for (const plain of ["([] a:1 2)", "([k:1 2] v:3 4)", "til 5"]) {
      assert.strictEqual((await connection.queryGrid(statements(plain), SIZE, 10, true)).grid.tree, undefined, plain);
    }
  });
  await t.test("a cut result held for paging is sent page by page, ranked as q ranks the whole (#922)", async () => {
    const { gridLambda, PAGE, readPage, appendPage, readGridAnswer } = require("../out/grid.js");
    const code = "([k:til 23] v:23#3 1 2 0n 5f; s:23#`c`a`b)";
    const full = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
    let grid = readGridAnswer(await connection.call(gridLambda(false, TOKEN), statements(code), SIZE, 10)).grid;
    assert.strictEqual(grid.cells[0].length, 10);
    while (grid.cells[0].length < grid.count) {
      const page = readPage(await connection.call(PAGE, TOKEN, grid.cells[0].length, 10));
      assert.notStrictEqual(typeof page, "string", page);
      grid = appendPage(grid, page);
    }
    assert.deepStrictEqual(grid.cells, full.cells);
    assert.deepStrictEqual(grid.rank, full.rank);
    // Past the end: no rows; a result not cut empties what was held.
    assert.strictEqual(readPage(await connection.call(PAGE, TOKEN, 23, 10)).cells[0].length, 0);
    await connection.call(gridLambda(false, TOKEN), statements("([] a:1 2)"), SIZE, 10);
    assert.strictEqual(readPage(await connection.call(PAGE, TOKEN, 0, 10)), "held");
    // A partitioned table is held by reference and read with .Q.ind.
    grid = readGridAnswer(await connection.call(gridLambda(false, TOKEN), statements("p"), SIZE, 4)).grid;
    grid = appendPage(grid, readPage(await connection.call(PAGE, TOKEN, 4, 4)));
    assert.deepStrictEqual(grid.cells[1], ["a", "b", "c", "a", "b", "c"]);
    assert.deepStrictEqual(grid.cells[0].slice(3), ["2026.01.02", "2026.01.02", "2026.01.02"]);
    // Asked without hold, nothing is defined.
    const before = (await connection.query(statements("key `.qlint"), SIZE)).text.join("");
    await connection.queryGrid(statements("([] a:til 50)"), SIZE, 10);
    assert.strictEqual((await connection.query(statements("key `.qlint"), SIZE)).text.join(""), before);
  });

  await t.test("an exported q literal rebuilds the table exactly, and a drill-down's value runs as written (#921, #927)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const { fillDrilldown } = require("../out/drilldown.js");
    const code =
      '([k:(`a;`b;`$"c d")] b:101b; x:0x0a00ff; h:1 0N 0Wh; i:1 0N -0Wi; j:9007199254740993 0N 0W; e:(1.5e;0Ne;0we); f:3.14159265358979 0n -0w; c:"x y"; ' +
      "p:(2024.01.02D03:04:05.123456789;0Np;0Wp); m:(2024.01m;0Nm;2023.12m); d:(2024.01.31;0Nd;1999.12.31); z:(2024.01.02T03:04:05.123;0Nz;0wz); " +
      'n:(0D01:02:03.000000004;0Nn;-0D00:00:01); u:(10:30;0Nu;23:59); v:(10:30:01;0Nv;00:00:00); t:(10:30:01.002;0Nt;23:59:59.999); ' +
      'g:("G"$"8c680a01-5a49-5aab-5a65-d4bfddb6a661";0Ng;"G"$"00000000-0000-0000-0000-000000000001"); l:("abc";`x`y;1 2 3); q:("say \\"hi\\"|x";"";"tab\\there"))';
    const grid = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
    const literal = tableLiteral(grid).code;
    const same = await connection.query(statements(`(${code})~${literal}`), SIZE);
    assert.deepStrictEqual(same.text, ["1b"], literal);
    // Each cell drills down to a query that finds its own row.
    for (const [column, row] of [[0, 2], [6, 0], [10, 1], [18, 0]]) {
      const filled = fillDrilldown(`exec i from 0!(${code}) where {{column}}={{value}}`, grid, column, row);
      assert.ok("code" in filled, filled.error);
    }
    const filled = fillDrilldown(`exec i from 0!(${code}) where k={{value}}, d={{row.d}}`, grid, 0, 2);
    assert.deepStrictEqual((await connection.query(statements(filled.code), SIZE)).text, [",2"]);
  });

  await t.test("an exported q literal rebuilds a minute, second or time of 100 hours or more, which q writes as ** (#1967)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const { fillDrilldown } = require("../out/drilldown.js");
    const tables = [
      '([] c0:"u"$0N 6000)',
      '([] u:"u"$0N 6000 -6000 5999 0W -0W 59; v:"v"$0N 360000 -360000 359999 0W -0W 59; t:"t"$0N 360000000 -360000000 359999999 0W -0W 59)',
      '([k:"u"$6000 1] v:"v"$2147483646 1)',
      '([] t:1#"t"$-2147483646)',
    ];
    for (const code of tables) {
      const grid = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
      const literal = tableLiteral(grid).code;
      const same = await connection.query(statements(`(${code})~${literal}`), SIZE);
      assert.deepStrictEqual(same.text, ["1b"], `${code}\nwritten as\n${literal}`);
    }
    const grid = (await connection.queryGrid(statements(tables[1]), SIZE, 100)).grid;
    assert.deepStrictEqual(grid.cells[0].slice(1, 3), ["**:00", "-**:00"]);
    const filled = fillDrilldown(`exec i from ${tables[1]} where u={{value}}, t={{row.t}}`, grid, 0, 2);
    assert.deepStrictEqual((await connection.query(statements(filled.code), SIZE)).text, [",2"]);
  });

  await t.test("an exported q literal rebuilds a lone generic null or operator, which enlist alone would not take (#1968)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const items = ["(::)", "(+)", "(+/)", "(+:)", "(-:)", "(#:)", "(-)", "(%)", "(.)", "(@)", "enlist(::)", "enlist enlist(::)", "(enlist(::);1)", "enlist(+)", "enlist(-:)", "(1.5;enlist(::))", "enlist(1.5;(::))", "(enlist`a)!enlist(::)", "(1 2!3 4;::)", "{x+1}", "+[1]", "-1", "-0w"];
    // Not enlist (:) or enlist (') inside an item: -3! writes them ,: and ,' as it writes the monadic comma and join-each.
    const tables = ["([] c0:enlist 0Nh; c1:enlist (::); c2:enlist 0Nd; c3:enlist 0w)", "([] c:enlist (:))", "([] c:((:);1))", "([] c:enlist ('))", "([] c:((');1))", ...items.flatMap((v) => [`([] c:enlist ${v})`, `([] c:(${v};1))`, `([] c:enlist enlist ${v})`])];
    for (const code of tables) {
      const grid = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
      const literal = tableLiteral(grid).code;
      const same = await connection.query(statements(`(${code})~${literal}`), SIZE);
      assert.deepStrictEqual(same.text, ["1b"], `${code}\nwritten as\n${literal}`);
    }
  });

  // -3! writes the join verb and its derived functions bare - (,;1), (,/;1),
  // ,, for enlist(,) - and each became enlist: another value, or 'parse (#2409).
  await t.test("an exported q literal rebuilds the join verb and its iterator forms, not enlist (#2409)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const items = ["(,)", "(,/)", "(,')", "(,\\)", "(,/:)", "(,\\:)", "(,':)", "`a`b!((,/);(+))"];
    const tables = items.flatMap((v) => [`([] c:(${v};1))`, `([] c:enlist ${v})`, `([] c:enlist enlist ${v})`]);
    for (const code of tables) {
      const grid = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
      const literal = tableLiteral(grid).code;
      const same = await connection.query(statements(`(${code})~${literal}`), SIZE);
      assert.deepStrictEqual(same.text, ["1b"], `${code}\nwritten as\n${literal}`);
    }
  });

  await t.test("an exported q literal rebuilds a one-character string in a list, a symbol starting with _ and the other awkward cells (0.29.0 bug)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const tables = [
      // A one-character string among strings, `-3!`'s `,"x"`, which q refuses
      // as a list item; an empty string; quotes, a backslash and a two-byte
      // character; symbols q cannot read bare: one starting with _, the
      // empty one, one with a space.
      '([] s:`$("a";"_y";"";"a b";"x.y"); w:("ab";enlist "x";"";"\\"q\\"\\\\";"é"); c:"ab cd")',
      // A general column's items as `-3!` writes them: a monadic , before a
      // string, a list, a symbol and a dictionary's values, and a symbol
      // starting with _, alone and first in a vector.
      '([] l:(enlist "x";`$"_z";enlist 1 2;enlist `$"_w";`a`b!(1;enlist 2);enlist enlist "y";`$("_v";"u")))',
      // One row: every column enlisted once more.
      '([] s:enlist `$"_y"; w:enlist enlist "x"; l:enlist enlist `$"_q")',
      // Keyed by a symbol starting with _, so a name list is written too.
      '([k:`$("_a";"b")] v:(enlist "x";"yz"))',
      // Tables in a general column, which -3! writes with k's monadic + (#1501).
      // Floats and reals nested in a general column's items (#1502).
      '([] f:(1.23456789012 2.5;(1;2.1234567891234;`a;0.1 0N -0w 0we);enlist 0.1 0n;(enlist 3.14159265358979;"x");`float$();enlist(1.5;0n)))',
      '([] t:(([]a:`p`r);([k:1 2]v:3 4);enlist ([]a:1 2);flip(`$"a b";`c)!(1 2;3 4);1))',
      // Floats in a dictionary or a table in a general column's items (#1746).
      '([] d:(`a`b!1.123456789 2;([]a:1.123456789 2);([k:1 2]v:0.1234567891 3);(1;`a`b!1.5 2.123456789);`a`b!1 2;1))',
    ];
    for (const code of tables) {
      const grid = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
      const literal = tableLiteral(grid).code;
      const same = await connection.query(statements(`(${code})~${literal}`), SIZE);
      assert.deepStrictEqual(same.text, ["1b"], `${code}\nwritten as\n${literal}`);
    }
  });

  // q's `iasc` marks a sorted vector `s#` where it is, and the columns
  // ranked can be the user's own: a read must not change them (#1863).
  await t.test("showing a sorted table, keyed table, dictionary or list leaves its attributes as they were (#1863)", async () => {
    const { gridLambda, PAGE, readPage, readGridAnswer } = require("../out/grid.js");
    const state =
      "{(attr each flip st;attr each flip key skt;attr each flip value skt;attr key sd;attr value sd;" +
      "attr each flip key sdt;attr each flip value sdt;attr sl;raze string md5 `char$raze -8!'(st;skt;sd;sdt;sl))}";
    const before = await connection.call(state, 0);
    // No attribute anywhere (a null symbol is null here).
    assert.deepStrictEqual(before.slice(0, 8), [{ time: null, px: null, sym: null }, { k: null, j: null }, { v: null }, null, null, { a: null }, { b: null }, null]);
    const shown = {};
    for (const name of ["st", "skt", "sd", "sdt", "sl"]) {
      for (const tree of [false, true]) {
        const grid = (await connection.queryGrid(statements(name), SIZE, 100, tree)).grid;
        assert.ok(grid.rank.every((r) => r.length === grid.cells[0].length), name);
        shown[name] = grid.rank;
      }
      // Held for paging and paged too: a page past the first is the held
      // table's own rows.
      const held = readGridAnswer(await connection.call(gridLambda(false, TOKEN), statements(name), SIZE, 1)).grid;
      assert.strictEqual(typeof readPage(await connection.call(PAGE, TOKEN, 0, 100)), "object", name);
      assert.strictEqual(held.cells[0].length, 1);
    }
    // Ranked as before: a sorted column's ranks are its rows' places.
    assert.deepStrictEqual(shown.st, [[0, 1, 2], [0, 1, 2], [0, 1, 2]]);
    assert.deepStrictEqual(await connection.call(state, 0), before);
  });
});

// One .qlint.held for the whole process: a second client's, or this
// client's next, grid query replaced the result, and scrolling the first
// grid appended the other's rows to it (#2128).
test("rows added by Load more read symbols from their bytes, keep them for Copy as q, and sort as q sorts (#2452, #2453, #2461, #2462, #2463, #2464)", { skip }, async (t) => {
  const { gridLambda, PAGE, readPage, readGridAnswer, appendPage, toGrid } = require("../out/grid.js");
  const { tableLiteral } = require("../out/qliteral.js");
  const q = await startQ(() =>
    [
      'sym:`$("caf\\351";"x\\377";"ok");',
      't:([] s:`$("x\\377";"caf\\351";"a";"b");e:`sym$`sym$`$("caf\\351";"ok";"x\\377";"ok");g:(10;`a;100;2.5);c:"\\377b\\351a";l:(`$"caf\\351";1;`$("x\\377";"y");2))',
      "",
    ].join("\n"),
  );
  t.after(() => q.stop());
  const c = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => c.abort());
  const tok = "c".repeat(32);
  const first = readGridAnswer(await c.call(gridLambda(false, tok), statements("t"), SIZE, 2)).grid;
  // The first two rows' s has bytes past ASCII; the page's "a" "b" none.
  const page = readPage(await c.call(PAGE, tok, 2, 2));
  assert.notStrictEqual(typeof page, "string", page);
  assert.deepStrictEqual(page.cells[1], ["x\u00ff", "ok"]);
  const all = appendPage(first, page);
  assert.deepStrictEqual(all.cells[0], ["x\u00ff", "caf\u00e9", "a", "b"]);
  assert.deepStrictEqual(all.cells[1], ["caf\u00e9", "ok", "x\u00ff", "ok"]);
  assert.deepStrictEqual(all.cells[4], ["`caf\u00e9", "1", "`x\u00ff`y", "2"]);
  const copied = tableLiteral(all).code;
  assert.deepStrictEqual((await c.query(statements(`(select s from t)~select s from ${copied}`), SIZE)).text, ["1b"], copied);
  assert.deepStrictEqual((await c.query(statements(`(exec value e from t)~exec e from ${copied}`), SIZE)).text, ["1b"], copied);
  // q's order: a general column cannot be sorted by its text, so is not
  // ranked once paged; a char column sorts by its byte.
  const grid = toGrid(all, -1);
  assert.strictEqual(grid.rank[2], null);
  const order = (r) => r.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  assert.deepStrictEqual(order(grid.rank[3]), [3, 1, 2, 0]);
});

test("a column name with a byte past UTF-8 shows as its Latin-1 text, pages, and copies as q as the same name (#2467)", { skip }, async (t) => {
  const { gridLambda, PAGE, readPage, readGridAnswer, appendPage } = require("../out/grid.js");
  const { tableLiteral } = require("../out/qliteral.js");
  const q = await startQ(() => 't:flip(`$("caf\\351";"caf\\303\\251";"a"))!(1 2 3 4;5 6 7 8;9 10 11 12)\n');
  t.after(() => q.stop());
  const c = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => c.abort());
  const tok = "d".repeat(32);
  const first = readGridAnswer(await c.call(gridLambda(false, tok), statements("t"), SIZE, 2)).grid;
  assert.deepStrictEqual(first.names, ["caf\u00e9", "caf\u00e9", "a"]);
  const all = appendPage(first, readPage(await c.call(PAGE, tok, 2, 2)));
  const copied = tableLiteral(all).code;
  assert.deepStrictEqual((await c.query(statements(`t~${copied}`), SIZE)).text, ["1b"], copied);
});

test("a held result is paged only by the client and the token it was held for (#2128)", { skip }, async (t) => {
  const { gridLambda, PAGE, readPage, readGridAnswer } = require("../out/grid.js");
  const q = await startQ(() => "trade:([] sym:20#`A`B; px:til 20)\n");
  t.after(() => q.stop());
  const one = await QConnection.open({ host: "127.0.0.1", port: q.port });
  const two = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => (one.abort(), two.abort()));
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const first = readGridAnswer(await one.call(gridLambda(false, a), statements("select from trade where sym=`A"), SIZE, 5)).grid;
  await two.call(gridLambda(false, b), statements("select from trade where sym=`B"), SIZE, 5);
  const page = readPage(await one.call(PAGE, a, first.cells[0].length, 5));
  assert.notStrictEqual(typeof page, "string", page);
  assert.deepStrictEqual(page.cells[0], ["A", "A", "A", "A", "A"], "the other client's rows were sent");
  // Another client's token, or this client's earlier one, is refused.
  assert.strictEqual(readPage(await one.call(PAGE, b, 0, 5)), "held");
  await one.call(gridLambda(false, b), statements("select from trade where sym=`B"), SIZE, 5);
  assert.strictEqual(readPage(await one.call(PAGE, a, 5, 5)), "held");
  assert.deepStrictEqual(readPage(await two.call(PAGE, b, 5, 5)).cells[1], ["11", "13", "15", "17", "19"]);
  // A client gone leaves nothing held for it once another holds.
  two.abort();
  await new Promise((r) => setTimeout(r, 200));
  await one.call(gridLambda(false, a), statements("select from trade"), SIZE, 5);
  assert.strictEqual((await one.query(statements("count .qlint.held"), SIZE)).text.join(""), "1");
  assert.throws(() => gridLambda(false, 'x";system"echo'), /not a hold token/);
});
