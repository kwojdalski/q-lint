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
const { VARS, readVariables } = require("../out/notebookvars.js");
const { LIVE, readLiveValues } = require("../out/livemarkdown.js");

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
    // A big table or dictionary is written from its first items, its text as the whole's (#1559).
    const big = ["([] a:til 1000000; b:1000000#`x)", "(til 1000000)!til 1000000", "1000000#0b", "(1000000#enlist 1 2)"];
    const small = big.map((e) => e.replace(/1000000/g, "1000"));
    const got = readLiveValues(big, await connection.call(LIVE, big));
    const want = readLiveValues(small, await connection.call("{200 sublist -3!value x} each", small));
    big.forEach((e, k) => assert.strictEqual(got[e].text, want[small[k]].text, e));
    // One expression alone is still a list of one.
    assert.deepStrictEqual(readLiveValues(["d"], await connection.call(LIVE, ["d"])), { d: { text: "2024.01.01" } });
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
