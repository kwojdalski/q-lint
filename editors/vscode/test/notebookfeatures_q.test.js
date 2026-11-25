// The notebook's later features against a real q process: the variables
// lambda (#946), the live values lambda (#949), and the headless runner's
// command line (#947) running a parameterised notebook across two
// processes with `/ @process` (#950) into .qnb, HTML and Jupyter (#948).
// Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFile } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { VARS, readVariables, describeVariable } = require("../out/notebookvars.js");
const { LIVE, readLiveValues } = require("../out/livemarkdown.js");
const { liveValues } = require("../out/qnbrun.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const CLI = path.join(__dirname, "..", "out", "qnbrun.js");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(body, args = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-nbfeat-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, body);
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port} ${args}`, { shell: true, cwd: dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) {
      return { dir, port, stop: () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(-child.pid, "SIGKILL");
  throw new Error("q did not start listening");
}

const cli = (args, env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });

// A view is listed as one, with nothing read of it: `value` of its name
// would evaluate it after every cell (#1865).
test("the variables lambda lists a view as a view, and does not evaluate it (#1865)", { skip }, async (t) => {
  const q = await startQ("t:([] a:1 2)\nspy::select from t\nbad::1+`a\n");
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const pending = () => connection.call('{[x] string system"B"}', 0);
  const { variables, total } = readVariables(await connection.call(VARS, 1000));
  assert.deepStrictEqual(variables, [
    { name: "t", type: 98, count: 2, size: variables[0].size },
    { name: "spy", type: 100, view: true },
    { name: "bad", type: 100, view: true },
  ]);
  assert.deepStrictEqual(variables.map(describeVariable), [`table · 2 rows · ${variables[0].size} B`, "view", "view"]);
  assert.strictEqual(total, 3);
  assert.deepStrictEqual(await pending(), ["bad", "spy"]);
  // No view among the names sent, and no name at all: the same shape.
  assert.deepStrictEqual(readVariables(await connection.call(VARS, 1)).variables.map((v) => v.name), ["t"]);
  assert.deepStrictEqual(readVariables(await connection.call(VARS, 0)), { variables: [], total: 3 });
});

test("notebook features against a real q process", { skip }, async (t) => {
  const a = await startQ('t:([] i:til 3; s:("a";"<b>";"c"));f:{x+1};d:2024.01.01;sp:get (hsym `$":db/sp/") set ([] n:1 2 3)\n');
  const b = await startQ("");
  t.after(() => (a.stop(), b.stop()));
  const connection = await QConnection.open({ host: "127.0.0.1", port: a.port });
  t.after(() => connection.close());

  await t.test("the variables lambda lists the root globals with type, count and size, and defines nothing", async () => {
    const { variables, total } = readVariables(await connection.call(VARS, 1000));
    const by = Object.fromEntries(variables.map((v) => [v.name, v]));
    assert.deepStrictEqual(Object.keys(by).sort(), ["d", "f", "sp", "t"]);
    assert.deepStrictEqual([by.t.type, by.t.count, by.t.size > 0], [98, 3, true]);
    assert.deepStrictEqual([by.f.type, by.f.size], [100, undefined]);
    assert.deepStrictEqual([by.d.type, by.d.count], [-14, 1]);
    assert.strictEqual(by.sp.count, 3);
    assert.strictEqual(total, 4);
    assert.strictEqual(readVariables(await connection.call(VARS, 2)).variables.length, 2);
    assert.deepStrictEqual(readVariables(await connection.call(VARS, 1000)).variables.length, 4);
  });

  await t.test("the live lambda reads each expression on its own: text, characters, symbols and errors", async () => {
    const exprs = ["count t", "t[`s] 1", "`abc", "1+`a", "{x+1} 41", "til 1000", "\"c\""];
    const values = readLiveValues(exprs, await connection.call(LIVE, exprs));
    assert.deepStrictEqual(values["count t"], { text: "3" });
    assert.deepStrictEqual(values["t[`s] 1"], { text: "<b>" });
    assert.deepStrictEqual(values["`abc"], { text: "abc" });
    assert.deepStrictEqual(values["1+`a"], { error: "type" });
    assert.deepStrictEqual(values["{x+1} 41"], { text: "42" });
    assert.ok(values["til 1000"].text.length <= 200);
    assert.strictEqual(readLiveValues(["300#\"x\""], await connection.call(LIVE, ["300#\"x\""]))["300#\"x\""].text.length, 200);
    assert.deepStrictEqual(values['"c"'], { text: "c" });
    // Cut at the 200 characters asked for, not at the console's 80 (#1870).
    assert.strictEqual(values["til 1000"].text, Array.from({ length: 1000 }, (_, i) => i).join(" ").slice(0, 200));
    const wide = ["(til 50;`a`b)", "{x+y}[til 50]", "`a`b!(til 50;til 50)", "([] a:til 50)", "50#`alpha", "50#1.5"];
    const whole = readLiveValues(wide, await connection.call(LIVE, wide));
    wide.forEach((e) => assert.doesNotMatch(whole[e].text, /\.\./, e));
    assert.strictEqual(whole["{x+y}[til 50]"].text, `{x+y}[${Array.from({ length: 50 }, (_, i) => i).join(" ")}]`);
    assert.strictEqual(whole["([] a:til 50)"].text, `+(,\`a)!,${Array.from({ length: 50 }, (_, i) => i).join(" ")}`);
    assert.deepStrictEqual(Array.from((await connection.evaluate("system\"c\"")).value, Number), [25, 80]);
    // A big table or dictionary is written from its first items, its text
    // as the old unbounded -3! of the same value wrote it (#1559) on a
    // console wide enough to write 200 characters.
    const big = ["([] a:til 1000000; b:1000000#`x)", "(til 1000000)!til 1000000", "1000000#0b", "(1000000#enlist 1 2)", "([k:til 1000000] v:1000000#`x)", "`s#til 300", "`u#til 300", "([]time:`s#til 300;x:300#1)", "([k:`u#til 300]x:300#1)", "(`s#til 300)!300#1"];
    const got = readLiveValues(big, await connection.call(LIVE, big));
    const want = readLiveValues(big, await connection.call('{c:system"c";system"c 2000 2000";r:{(1b;200 sublist -3!value x)} each x;system"c "," "sv string c;r}', big));
    big.forEach((e) => {
      assert.strictEqual(typeof want[e].text, "string", e);
      assert.strictEqual(got[e].text, want[e].text, e);
    });
    // One expression alone is still a list of one.
    assert.deepStrictEqual(readLiveValues(["d"], await connection.call(LIVE, ["d"])), { d: { text: "2024.01.01" } });
    // Cut on a character, never inside a UTF-8 one or a -3! escape (#2071).
    const wide8 = ['raze 100#enlist "\\346\\227\\245"', '`$raze 100#enlist "\\346\\227\\245"', 'enlist raze 100#enlist "\\346\\227\\245"', 'raze 300#enlist "a\\303\\251"'];
    const cut8 = readLiveValues(wide8, await connection.call(LIVE, wide8));
    assert.strictEqual(cut8[wide8[0]].text, "日".repeat(66));
    assert.strictEqual(cut8[wide8[1]].text, "日".repeat(66));
    assert.strictEqual(cut8[wide8[2]].text, `,"${"\\346\\227\\245".repeat(16)}\\346`);
    assert.strictEqual(cut8[wide8[3]].text, "aé".repeat(66) + "a");
  });

  // The process is sent the expression as written, so a continuation line's
  // `>` is q's greater-than; a blockquote's own marker is not sent (#1993).
  await t.test("a live value continued on a line starting with > is compared, not joined (#1993)", async () => {
    const sources = ["Big: {{q: 5\n    >3}}", "Ok: {{q: 3 4 5\n\t>=4}} and {{q: sum 10 20 30\r\n    >15}}", "> total {{q: sum\n> til 4}}", '{{q: "a\n   b"}}'];
    assert.deepStrictEqual(await liveValues(connection, sources), [
      { "5\n >3": { text: "1b" } },
      { "3 4 5\n >=4": { text: "011b" }, "sum 10 20 30\n >15": { text: "2i" } },
      { "sum\n til 4": { text: "6" } },
      { '"a\n b"': { text: "a\n   b" } },
    ]);
  });

  // A table cell's `\|` is the cell's `|`, and q is sent that (#1999).
  await t.test("a live value in a table cell with an escaped | is q's or, and is kept under the key the page reads (#1999)", async () => {
    const sources = ["| a | b |\n|---|---|\n| {{q: 1\\|2}} | {{q: (\\|/)1 5 3}} |", "| a | b |\n|---|---|\n| {{q: `unset\\|1|2}} | x |"];
    assert.deepStrictEqual(await liveValues(connection, sources), [{ "1|2": { text: "2" }, "(|/)1 5 3": { text: "5" } }, {}]);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-nbrun-"));
  const notebook = path.join(dir, "report.qnb");
  fs.writeFileSync(
    notebook,
    JSON.stringify({
      qnb: 1,
      cells: [
        { kind: "code", source: ["/ @parameters", "n:2;", "tag:`base"] },
        { kind: "markdown", source: ["Rows: {{q: n}}, tag {{q: tag}}, and `{{q: never}}`"] },
        { kind: "code", source: ["/ @grid", "r:([] i:til n; s:n#enlist \"<script>\")", "r"] },
        { kind: "code", source: ["/ @process other", "string system \"p\""] },
        { kind: "code", source: ["/ @chart bar", "([] x:1 2 3; y:3 1 2)"] },
      ],
    }),
  );
  const list = path.join(dir, "processes.json");
  fs.writeFileSync(list, JSON.stringify({ processes: [{ label: "other", host: "127.0.0.1", port: b.port, tags: ["dev"] }, { label: "live", host: "127.0.0.1", port: b.port, tags: ["prod"] }] }));

  await t.test("the command line runs a notebook with parameters, on the process each cell names, into a .qnb", async () => {
    const out = path.join(dir, "run.qnb");
    const r = await cli([notebook, "--process", `127.0.0.1:${a.port}`, "--processes", list, "-p", "n", "4", "-p", "tag", "`given", "-o", out]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /ran 5 cells/);
    const run = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepStrictEqual(run.cells[1].source, ["/ Parameters given to this run.", "n:4;", "tag:`given;"]);
    assert.deepStrictEqual(run.cells[2].metadata["q-lint.liveValues"], { n: { text: "4" }, tag: { text: "given" } });
    assert.deepStrictEqual(run.cells[2].source, ["Rows: {{q: n}}, tag {{q: tag}}, and `{{q: never}}`"]);
    assert.match(run.cells[3].outputs[0].items[1].text, /^i s\s*\n-+\n0 <script>/);
    assert.strictEqual(run.cells[4].outputs[0].items[0].text, `"${b.port}"`);
    assert.strictEqual(run.cells[5].outputs[0].items[0].mime, "application/vnd.q-lint.chart+json");
    assert.deepStrictEqual(run.cells.map((c) => c.execution?.order), [1, 2, undefined, 3, 4, 5]);
  });

  await t.test("into HTML, escaped and with its live values, and into Jupyter", async () => {
    const html = path.join(dir, "run.html");
    assert.strictEqual((await cli([notebook, "--process", `127.0.0.1:${a.port}`, "--processes", list, "-o", html])).code, 0);
    const page = fs.readFileSync(html, "utf8");
    assert.doesNotMatch(page, /<script/);
    assert.match(page, /Rows: <span class="live" title="q: n">2<\/span>, tag <span class="live" title="q: tag">base<\/span>, and <code>\{\{q: never\}\}<\/code>/);
    const ipynb = path.join(dir, "run.ipynb");
    assert.strictEqual((await cli([notebook, "--process", `127.0.0.1:${a.port}`, "--processes", list, "-o", ipynb])).code, 0);
    const nb = JSON.parse(fs.readFileSync(ipynb, "utf8"));
    assert.strictEqual(nb.cells[3].outputs[0].data["text/plain"][0], `"${b.port}"`);
  });

  await t.test("a production process is refused unless allowed; a failing cell stops the run with exit 1", async () => {
    const prod = path.join(dir, "prod.qnb");
    fs.writeFileSync(prod, JSON.stringify({ qnb: 1, cells: [{ kind: "code", source: ["1"] }, { kind: "code", source: ["/ @process live", "1+`a"] }, { kind: "code", source: ["2"] }] }));
    const refused = await cli([prod, "--process", `127.0.0.1:${a.port}`, "--processes", list, "-o", path.join(dir, "p1.qnb")]);
    assert.strictEqual(refused.code, 1);
    assert.match(refused.stderr, /live is a production process \(tagged prod\); pass --allow-production/);
    const allowed = await cli([prod, "--process", `127.0.0.1:${a.port}`, "--processes", list, "--allow-production", "-o", path.join(dir, "p2.qnb")]);
    assert.strictEqual(allowed.code, 1);
    assert.match(allowed.stderr, /cell 2 failed: 'type/);
    const run = JSON.parse(fs.readFileSync(path.join(dir, "p2.qnb"), "utf8"));
    assert.strictEqual(run.cells[2].execution, undefined);
    assert.strictEqual((await cli([prod])).code, 2);
    assert.strictEqual((await cli(["/nonexistent.qnb", "--process", "h:1"])).code, 2);
  });
});
