// Toggle Parameter Cache (#892) against a real q process: each lambda is
// instrumented as the command instruments it, its definition run as Query
// Block runs it, called once, and then a line of its body run on its own,
// which must see the call's arguments. Needs a q binary, so it runs only when
// QLINT_TEST_Q names one (a command line, run by the shell, as for
// qclient.test.js) and is skipped otherwise - CI has no q.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const { toggleAt } = require("../out/paramcache.js");

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

async function startQ(dir) {
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, "/ an empty process for the parameter cache tests\n");
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
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

/// `source` with the lambda at `needle` instrumented, as the command does it.
function instrument(source, needle) {
  const t = toggleAt(source, source.indexOf(needle));
  assert.strictEqual(t.kind, "insert", `${needle}: ${t.message ?? ""}`);
  const after = source.slice(0, t.offset) + t.text + source.slice(t.offset);
  // And toggled again, the source comes back byte for byte.
  const back = toggleAt(after, after.indexOf(needle));
  assert.strictEqual(back.kind, "remove");
  assert.strictEqual(after.slice(0, back.start) + after.slice(back.end), source);
  return { text: after, id: /\.qlint\.cache\.(p[0-9a-f]{6})/.exec(t.text)[1] };
}

test("a cached lambda's body lines run on their own with the call's arguments, on a real q process", { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-paramcache-"));
  const q = await startQ(dir);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  const run = async (code) => {
    const answer = await connection.query(statements(code), SIZE);
    assert.strictEqual(answer.ok, true, `${code}: '${answer.error}`);
    return answer.text.join("\n");
  };

  await t.test("multi-line, several parameters: the statement on its own indented line", async () => {
    const source = "calc:{[a;b;c]\n  s:a+b;\n  s*c\n  }\n";
    const { text, id } = instrument(source, "s*c");
    assert.match(text, /^calc:\{\[a;b;c\]\n  \.qlint\.cache\.p[0-9a-f]{6}:\(a;b;c\);`a`b`c set'/);
    await run(text);
    assert.strictEqual(await run("calc[1;2;3]"), "9");
    // Query Current Line on each body line, as the editor sends them.
    await run("  s:a+b;");
    assert.strictEqual(await run("  s*c"), "9");
    assert.strictEqual(await run("(a;b;c)"), "1 2 3");
    assert.strictEqual(await run(`.qlint.cache.${id}`), "1 2 3");
  });

  await t.test("one parameter: set as an atom name, whatever its value", async () => {
    const source = "dbl:{[v] v*2}";
    const { text, id } = instrument(source, "v*2");
    assert.ok(text.includes("`v set "), text);
    await run(text);
    assert.strictEqual(await run("dbl 1 2 3"), "2 4 6");
    assert.strictEqual(await run("v*2"), "2 4 6");
    assert.strictEqual(await run(`.qlint.cache.${id}`), "1 2 3");
    // A second call sets it again.
    await run("dbl 1.5");
    assert.strictEqual(await run("v"), "1.5");
  });

  await t.test("implicit x, y and z", async () => {
    const { text } = instrument("add3:{x+y+z}", "+y");
    await run(text);
    assert.strictEqual(await run("add3[1;10;100]"), "111");
    assert.strictEqual(await run("x+y+z"), "111");
    const minus = instrument("minus:{0-x}", "0-x");
    await run(minus.text);
    assert.strictEqual(await run("minus 5"), "-5");
    assert.strictEqual(await run("0-x"), "-5");
  });

  await t.test("arguments of different types, and lists of the same length", async () => {
    const mix = instrument("mix:{[s;n] n#s}", "n#s");
    await run(mix.text);
    assert.strictEqual(await run("mix[`a;3]"), "`a`a`a");
    assert.strictEqual(await run("n#s"), "`a`a`a");
    const pair = instrument("pair:{[m;k] m+k}", "m+k");
    await run(pair.text);
    assert.strictEqual(await run("pair[1 2;3 4]"), "4 6");
    assert.strictEqual(await run("m"), "1 2");
    assert.strictEqual(await run("k"), "3 4");
  });

  await t.test("a nested lambda caches its own parameter", async () => {
    const { text } = instrument("outer:{[t]\n  {[u] u*10} each t}", "u*10");
    await run(text);
    assert.strictEqual(await run("outer 1 2"), "10 20");
    // Each call sets it again: the last one's argument stays.
    assert.strictEqual(await run("u*10"), "20");
  });

  await t.test("a parameter list with a comment in it: q takes its names, and so does the cache (#1949)", async () => {
    const source = "wtot:{[p; / the prices\n  q0] / and the sizes\n  p wsum q0}";
    // q's own reading of the list, before anything is inserted.
    await run(source);
    assert.strictEqual(await run("(value wtot) 1"), "`p`q0");
    const { text, id } = instrument(source, "p wsum");
    assert.ok(text.includes(`  q0].qlint.cache.${id}:(p;q0);`), JSON.stringify(text));
    await run(text);
    assert.strictEqual(await run("(value wtot) 1"), "`p`q0");
    assert.strictEqual(await run("wtot[1 2;3 4]"), "11f");
    assert.strictEqual(await run("  p wsum q0"), "11f");
    assert.strictEqual(await run(`.qlint.cache.${id}`), "1 2\n3 4");
  });

  await t.test("a script with tabs, loaded by q's own \\l, still reads", async () => {
    const source = "/ a script\nscale:{[w;f]\t\n\t\tr:w*f;\n\n\t\tr+1}\n";
    const { text } = instrument(source, "r+1");
    assert.ok(text.includes("\t\n\t\t.qlint.cache."), JSON.stringify(text));
    const file = path.join(dir, "scale.q");
    fs.writeFileSync(file, text);
    await run(`\\l ${file}`);
    assert.strictEqual(await run("scale[2;3]"), "7");
    await run("\t\tr:w*f;");
    assert.strictEqual(await run("\t\tr+1"), "7");
  });
});
