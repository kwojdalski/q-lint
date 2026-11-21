// The q idiom snippets against a real q (#944): every statement of every
// idiom, as inserted with its defaults, parses, and the joins and the
// bucketed select run over tables of the names they default to. Needs a q
// binary, so it runs only when QLINT_TEST_Q names one, as qclient.test.js
// does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { readIdioms, preview } = require("../out/idioms.js");

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

const idioms = readIdioms(fs.readFileSync(path.join(__dirname, "..", "snippets", "idioms.json"), "utf8"));

/// The statements of a body: a line at column 0 starts one, a `/` line is a
/// comment, and a `\\` line a system command.
function statements(body) {
  const out = [];
  for (const line of body.split("\n")) {
    if (/^\s/.test(line) && out.length > 0) {
      out[out.length - 1] += `\n${line}`;
    } else if (!line.startsWith("/") && line.trim() !== "") {
      out.push(line);
    }
  }
  return out;
}

const TABLES = [
  "trades:([] sym:`a`b`a; time:2024.01.02D10:00:00 2024.01.02D10:00:01 2024.01.02D10:00:02; price:1 2 3f)",
  "quotes:`sym`time xasc ([] sym:`a`a`b; time:2024.01.02D09:59:59 2024.01.02D10:00:01 2024.01.02D10:00:00; bid:0.9 2.9 1.9; ask:1.1 3.1 2.1)",
  "t:([] sym:`a`b`c; x:1 2 3)",
  "ref:([] sym:`a`b; y:10 20)",
  "t1:([] a:1 2; b:`x`y)",
  "t2:([] a:3 4; c:1.5 2.5)",
  "",
].join("\n");

test("every statement of every idiom parses, as inserted", { skip }, async (t) => {
  const c = await connect(t, "");
  for (const idiom of idioms) {
    for (const statement of statements(preview(idiom.body))) {
      if (statement.startsWith("\\")) {
        assert.match(statement, /^\\(d \.\w*|t \d+)$/, `${idiom.prefix}: ${statement}`);
        continue;
      }
      await assert.doesNotReject(c.call("{parse x}", statement), `${idiom.prefix}: ${statement}`);
    }
  }
});

test("the joins and the bucketed select run over tables of their default names", { skip }, async (t) => {
  const c = await connect(t, TABLES);
  const counts = {};
  for (const prefix of ["aj", "aj0", "wj", "wj1", "lj", "ij", "uj", "xbar"]) {
    const idiom = idioms.find((i) => i.prefix === prefix);
    const code = statements(preview(idiom.body)).join(";");
    counts[prefix] = String((await c.call("{count value x}", code)));
  }
  assert.deepStrictEqual(counts, { aj: "3", aj0: "3", wj: "3", wj1: "3", lj: "3", ij: "2", uj: "4", xbar: "2" });
  // aj takes the prevailing quote: trade a at 10:00:02 sees the 10:00:01 bid.
  assert.strictEqual(String(await c.call("{last exec bid from value x}", preview(idioms.find((i) => i.prefix === "aj").body))), "2.9");
});

test("the .z handlers, defined from the idioms, do what they say", { skip }, async (t) => {
  const c = await connect(t, "");
  for (const prefix of ["zpg", "zps", "zpo", "zpc", "zpw", "zws", "zexit"]) {
    const body = preview(idioms.find((i) => i.prefix === prefix).body);
    await c.call("{value x}", body);
  }
  // A query still answers through the new .z.pg, and .z.pw lets anyone in.
  assert.strictEqual(String(await c.call("{1+x}", 1)), "2");
  assert.strictEqual(String((await c.evaluate(".z.pw[`u;\"p\"]")).value), "true");
});
