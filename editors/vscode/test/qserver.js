// A q process for the real-q tests of the test tools (#979-#985): started on
// a free port from a script, killed when the test ends. Needs QLINT_TEST_Q.
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");

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

/// Start q on `source` (written to server.q, `$DIR` its directory, with
/// any `files` beside it) and connect; both are closed after `t`.
async function connect(t, source, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tools-"));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text.replaceAll("$DIR", dir));
  }
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source.replaceAll("$DIR", dir));
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: dir });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      t.after(stop);
      const connection = await QConnection.open({ host: "127.0.0.1", port });
      t.after(() => connection.close());
      return { connection, dir, output: () => output };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error(`q did not start listening: ${output}`);
}

module.exports = { connect, skip };
