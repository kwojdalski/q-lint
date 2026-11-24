// The live value hover's q against a real process (#940): the first name
// the process defines is read, by its namespace's key and never evaluated
// to be found, and a view is named and not run. Needs a q binary, so it
// runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { VALUE_PREVIEW, PREVIEW_LIMIT, readPreview, previewMarkdown, previewNames } = require("../out/valuehover.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-live-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source.replaceAll("$DIR", dir));
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true, cwd: dir });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
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
  throw new Error(`q did not start listening: ${stderr}`);
}

async function connect(t, source) {
  const q = await startQ(source);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  return connection;
}

const SERVER = [
  "rate:1",
  "\\d .lib",
  "r:2",
  "d.x:3",
  "f:{[a;b] a+b}",
  "\\d .",
  ".q.myq:{x}",
  "t:([] a:til 100000; b:100000#`x`y)",
  "kt:([k:1 2 3] v:4 5 6)",
  "dict:`a`b!1 2",
  "calls:0",
  "v::calls+::1",
  "s:5000#\"ab\"",
  "x:7",
  "u:`$600#enlist \"\\303\\251\\303\\251\\303\\251\"",
  "tt:([]a:u)",
  "",
].join("\n");

const preview = async (c, names) => readPreview(await c.call(VALUE_PREVIEW, previewNames(names), PREVIEW_LIMIT));

test("the first name the process defines is read, as the console prints it, within the limit", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  assert.deepStrictEqual(await preview(c, [".lib.r", "r"]), { found: true, name: ".lib.r", type: -7, count: 1, text: "2\n" });
  // Under \\d .lib a bare `r` may be `.lib.r` or a root `r`: the first defined wins.
  assert.strictEqual((await preview(c, [".nope.r", "rate"])).name, "rate");
  const f = await preview(c, [".lib.f"]);
  assert.deepStrictEqual([f.type, f.text], [100, "{[a;b] a+b}\n"]);
  const table = await preview(c, ["t"]);
  assert.strictEqual(table.type, 98);
  assert.strictEqual(table.count, 100000);
  assert.match(table.text, /^a +b\n-+\n0 +x\n/);
  assert.ok(table.text.length < 5000, "the console's rows bound a table");
  assert.match(previewMarkdown(table, "dev"), /table, 100,000 rows/);
  assert.match(previewMarkdown(await preview(c, ["kt"]), "dev"), /: keyed table, 3 rows\n/);
  assert.match(previewMarkdown(await preview(c, ["dict"]), "dev"), /: dictionary, 2 items\n/);
  // A one-character name, which reaches q as a char.
  assert.strictEqual((await preview(c, ["x"])).text, "7\n");
  // The console's width bounds a long string; the limit cuts what is left.
  assert.ok((await preview(c, ["s"])).text.length <= 200);
  const cut = readPreview(await c.call(VALUE_PREVIEW, "s", 50));
  assert.strictEqual(cut.text.length, 50);
  assert.match(previewMarkdown(cut, "dev", 50), /The first 50 characters\.$/);
  // Cut on a character, never inside a UTF-8 one (#2071).
  for (const name of ["u", "tt"]) {
    const p = await preview(c, [name]);
    assert.doesNotMatch(p.text, /\uFFFD/, name);
  }
  const utf = readPreview(await c.call(VALUE_PREVIEW, "tt", 52));
  assert.strictEqual(utf.text, `a     \n------\n${"ééé\n".repeat(5)}é`);
  // A view is named and not evaluated: it would count its calls.
  assert.deepStrictEqual(await preview(c, ["v"]), { found: true, name: "v", view: true });
  assert.strictEqual(String((await c.evaluate("calls")).value), "0");
  assert.deepStrictEqual(await preview(c, ["nope", ".lib.nope"]), { found: false });
});
