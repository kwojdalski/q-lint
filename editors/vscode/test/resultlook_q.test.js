// The grid and charts of #1012-#1021 against a real q process: what the
// page reads from cells q wrote - a numeric list's sparkline, an order
// book's levels or lists, a map's positions - and the correlation it
// computes, checked against q's own `cor`. Needs a q binary, so it runs only
// when QLINT_TEST_Q names one, as grid_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const { toGrid } = require("../out/grid.js");
const { exportResult } = require("../out/resultexport.js");
const L = require("../media/gridlook.js");
const M = require("../media/chartmore.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-look-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
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

const SERVER = `
book:([] level:1 2 3; bidPx:99 98 97f; bidSize:5 10 0; askPx:101 102 0n; askSize:4 6 8)
lists:([] sym:\`a\`b; bids:(1.1 1.0;9 8f); bidSizes:(2 3;1 1); asks:(1.2 1.3;10 11f); askSizes:(1 1;1 1))
sides:([] side:\`buy\`sell\`buy\`sell; price:10 11 10 12f; qty:1 2 3 5)
places:([] city:\`Ldn\`NY\`Bad; lat:51.5 40.7 95; lon:-0.1 -74 0; pop:9 8 1)
nums:([] x:1 2 3 4 5f; y:2 4 6 9 11f; z:4 3 0n 1 0f; n:1 1 2 3 5)
vecs:([] v:(1 2 3f;0n 1 2f;enlist 4;til 300;1.5 2.25;\`long$()))
fmts:([] ret_PCT:0.0123 0.5; px:1 2f; px_BG:\`red\`green)
`;

test("the grid's dress and charts against a real q process", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  const grid = async (code) => {
    const answer = await connection.queryGrid(statements(code), SIZE, 1000);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    return { payload: answer.grid, grid: toGrid(answer.grid, -1) };
  };
  const all = (g) => [...Array(g.cells[0].length).keys()];

  await t.test("a column of numeric lists, as q wrote its cells, is read for its sparkline (#1014)", async () => {
    const { grid: g } = await grid("vecs");
    assert.strictEqual(L.isNumericList(g, 0), true);
    assert.deepStrictEqual(g.cells[0].map(L.parseNumbers).slice(0, 3), [[1, 2, 3], [null, 1, 2], [4]]);
    // Cut, at the process's \\c width or at 200 characters, it keeps whole numbers.
    const long = L.parseNumbers(g.cells[0][3]);
    assert.ok(long.length > 10 && long.every((v, i) => v === i), g.cells[0][3]);
    assert.deepStrictEqual(L.parseNumbers(g.cells[0][4]), [1.5, 2.25]);
    assert.deepStrictEqual(L.parseNumbers(g.cells[0][5]), []);
    assert.match(L.sparkUrl(L.parseNumbers(g.cells[0][1]), "#3794ff"), /^url\("data:image\/svg\+xml,/);
  });

  await t.test("formats named by suffix apply to the values q sent (#1012)", async () => {
    const { grid: g } = await grid("fmts");
    const formats = L.columnFormats(g);
    assert.strictEqual(L.formatNumber(formats[0], g.values[0][0], g.cells[0][0]), "1.23%");
    assert.strictEqual(formats[2].target, 1);
    assert.strictEqual(L.cssColour(g.cells[2][0]), "red");
  });

  await t.test("an order book by level, as lists and by side is read as q holds it (#1016)", async () => {
    const levels = M.depthData((await grid("book")).grid, [0, 1, 2]);
    assert.deepStrictEqual([levels.mid, levels.spread], [100, 2]);
    assert.deepStrictEqual([levels.datasets[0].data.slice(1), levels.datasets[1].data.slice(0, -1)], [[{ x: 98, y: 15 }, { x: 99, y: 5 }], [{ x: 101, y: 4 }, { x: 102, y: 10 }]]);
    const { grid: lg } = await grid("lists");
    assert.strictEqual(M.depthColumns(lg).mode, "lists");
    const lists = M.depthData(lg, [1]);
    assert.strictEqual(lists.mid, 9.5);
    assert.deepStrictEqual(lists.datasets[1].data.slice(0, -1), [{ x: 10, y: 1 }, { x: 11, y: 2 }]);
    const sides = M.depthData((await grid("sides")).grid, [0, 1, 2, 3]);
    assert.deepStrictEqual(sides.datasets[0].data.slice(1), [{ x: 10, y: 4 }]);
    assert.deepStrictEqual(sides.datasets[1].data.slice(0, -1), [{ x: 11, y: 2 }, { x: 12, y: 7 }]);
  });

  await t.test("a map drops a position off the map (#1017)", async () => {
    const { grid: g } = await grid("places");
    const d = M.mapData(g, all(g), { size: 3, colour: 0 }, { colours: ["#3794ff", "#d18616", "#89d185", "#f14c4c"] });
    assert.strictEqual(d.dropped, 1);
    assert.deepStrictEqual(d.datasets[0].data.map((p) => [p.x, p.y]), [[-0.1, 51.5], [-74, 40.7]]);
  });

  await t.test("the correlation matrix is q's cor, each pair over the rows where both are there (#1020)", async () => {
    const { grid: g } = await grid("nums");
    const c = L.correlation(g, all(g));
    assert.deepStrictEqual(c.names, ["x", "y", "z", "n"]);
    // q's own: for each pair, cor over the rows where neither is null.
    const { grid: qg } = await grid('{c:(x`x;x`y;x`z;"f"$x`n); ([] r:raze {[c;a] {[a;b] k:where not null[a]|null b; cor[a k;b k]}[a] each c}[c] each c)} nums');
    const flat = qg.values[0];
    assert.strictEqual(flat.length, 16);
    c.r.flat().forEach((r, i) => assert.ok(Math.abs(r - flat[i]) < 1e-12, `${i}: ${r} vs q ${flat[i]}`));
  });

  await t.test("a rule on a long column matches the rows q's own comparison does, past 2^53 too (#3085)", async () => {
    const look = require("../out/resultlook.js");
    const column = "9007199254740992 9007199254740993 9007199254740994 -9007199254740993 7 0N";
    const { grid: g } = await grid(`([] a:${column})`);
    for (const [op, text] of [["=", "9007199254740993"], ["<>", "9007199254740993"], [">", "9007199254740992"], [">=", "9007199254740993"], ["<", "9007199254740994"], ["<=", "-9007199254740993"], ["=", "7"], [">", "7"]]) {
      const rule = { column: "a", op, value: look.ruleValue(op, text, true), style: { bold: true } };
      // A null is in no rule; q's <> and < take it.
      const { grid: q } = await grid(`([] r:exec i from ([] a:${column}) where not null a, a${op}${text})`);
      assert.deepStrictEqual([...L.ruleRows(g, rule)].sort((x, y) => x - y).map(String), q.cells[0], `a ${op} ${text}`);
    }
  });

  await t.test("a rule on a float column matches the rows q's own tolerant comparison does (#3086)", async () => {
    const look = require("../out/resultlook.js");
    const column = "(0.1;0.2;0.1+0.2;0.3;0.3000001;-0.3;0f;1e15;1e15+0.125;0w;0n)";
    const { grid: g } = await grid(`([] a:${column})`);
    for (const [op, text] of [["=", "0.3"], ["<>", "0.3"], [">", "0.3"], [">=", "0.3"], ["<", "0.3"], ["<=", "0.3"], ["=", "0"], ["=", "1e15"], [">", "1e15"], ["<=", "-0.3"]]) {
      const rule = { column: "a", op, value: look.ruleValue(op, text, true), style: { bold: true } };
      const { grid: q } = await grid(`([] r:exec i from ([] a:${column}) where not null a, a${op}${text})`);
      assert.deepStrictEqual([...L.ruleRows(g, rule)].sort((x, y) => x - y).map(String), q.cells[0], `a ${op} ${text}`);
    }
  });

  await t.test("the HTML and Excel exports of a real result keep its rules (#1013)", async () => {
    const { payload } = await grid("nums");
    const rules = [{ column: "y", op: "top", value: 2, style: { background: "red" } }];
    const html = exportResult("html", payload, -1, undefined, rules).data.toString("utf8");
    assert.strictEqual((html.match(/style="background:#f14c4c"/g) || []).length, 2);
    assert.ok(exportResult("xlsx", payload, -1, undefined, rules).data.length > 0);
  });
});
