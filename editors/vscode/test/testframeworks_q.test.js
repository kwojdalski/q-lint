// The Test Explorer against the test frameworks it stands in for: one suite
// run by the framework's own runner, and by the Test Explorer on a fresh q,
// must come out the same, test by test - so that the next way the two part
// shows up here (#2100). Needs a q binary (QLINT_TEST_Q) and the framework:
// QLINT_TEST_K4UNIT names k4unit.q (KxSystems' k4unit).
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFile } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stub, vscode } = require("./vscode_stub");
const { QConnection } = require("../out/qclient.js");
const { registerTestExplorer } = require("../out/testexplorer.js");

const Q = process.env.QLINT_TEST_Q;
const K4UNIT = process.env.QLINT_TEST_K4UNIT;
const skipK4 = !Q ? "QLINT_TEST_Q names no q binary" : !K4UNIT ? "QLINT_TEST_K4UNIT names no k4unit.q" : false;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// A fresh q listening on a port, stopped by its process group.
async function startQ(t, dir) {
  const port = await freePort();
  const child = spawn(`${Q} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true, cwd: dir });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  t.after(stop);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      const connection = await QConnection.open({ host: "127.0.0.1", port });
      t.after(() => connection.close());
      return connection;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error("q did not start listening");
}

/// What a q script prints after `RESULT:`, read as JSON.
function runScript(dir, source) {
  const script = path.join(dir, "runner.q");
  fs.writeFileSync(script, source);
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", `${Q} ${JSON.stringify(script)} -q < /dev/null`], { cwd: dir, timeout: 30000 }, (error, stdout, stderr) => {
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
      if (line === undefined) {
        reject(new Error(`the runner printed no result: ${error?.message ?? ""} ${stdout} ${stderr}`));
      } else {
        resolve(JSON.parse(line.slice("RESULT:".length)));
      }
    });
  });
}

/// A Testing API that keeps each run's outcomes.
function fakeTests() {
  const items = (list) => ({
    list,
    replace(next) {
      list.splice(0, list.length, ...next);
    },
    add(item) {
      const at = list.findIndex((i) => i.id === item.id);
      if (at >= 0) list.splice(at, 1);
      list.push(item);
    },
    forEach(f) {
      [...list].forEach(f);
    },
  });
  vscode.tests = {
    createTestController: () => ({
      profiles: [],
      items: items([]),
      createTestItem: (id, label, uri) => ({ id, label, uri, children: items([]) }),
      createRunProfile(label, kind, handler, isDefault) {
        const profile = { label, kind, handler, isDefault };
        this.profiles.push(profile);
        return profile;
      },
      createTestRun: () => {
        const run = { token: { isCancellationRequested: false }, appendOutput() {}, end() {} };
        for (const e of ["enqueued", "started", "passed", "failed", "errored", "skipped"]) {
          run[e] = () => {};
        }
        return run;
      },
      dispose() {},
    }),
  };
  vscode.TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 };
  vscode.TestRunRequest = class {
    constructor(include, exclude) {
      this.include = include;
      this.exclude = exclude;
    }
  };
  vscode.TestMessage = class {
    constructor(message) {
      this.message = message;
    }
    static diff(message) {
      return new vscode.TestMessage(message);
    }
  };
  vscode.Range = class {};
  vscode.Location = class {};
  vscode.workspace.createFileSystemWatcher = () => ({
    onDidCreate: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    onDidChange: () => ({ dispose() {} }),
    dispose() {},
  });
  vscode.workspace.onDidSaveTextDocument = () => ({ dispose() {} });
  vscode.workspace.asRelativePath = (uri) => String(uri.fsPath);
}

/// A Live whose one process is `connection`.
function liveOn(connection) {
  const process = { label: "fresh", tags: [] };
  return {
    activeProcess: () => process,
    connectTo: async () => true,
    runOnActive: async (_code, query) => ({ process: process.label, value: await query(connection) }),
  };
}

// Each row is one of the ways the two have parted: a row's repeat (#2100).
const K4_SUITE = [
  "action,ms,bytes,lang,code,repeat,minver,comment",
  "before,0,0,q,cnt:0,1,,",
  "before,0,0,q,cnt+:1,3,,",
  "true,0,0,q,cnt=3,1,,",
  "run,0,0,q,cnt+:1,2,,",
  "true,0,0,q,cnt=5,1,,",
  "true,0,0,q,1b,2,,",
  "fail,0,0,q,1+`a,1,,",
  "",
].join("\n");

test("a k4unit suite passes and fails in the Test Explorer as k4unit's KUrt passes and fails it", { skip: skipK4 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-k4-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const csv = path.join(dir, "suite.csv");
  fs.writeFileSync(csv, K4_SUITE);
  const k4 = await runScript(
    dir,
    `\\l ${K4UNIT}\nKUltf hsym \`$"${csv}";\nKUrt[];\n-1 "RESULT:",.j.j exec ok from KUTR;\nexit 0\n`,
  );

  stub.reset();
  fakeTests();
  stub.config.user["testExplorer.enable"] = true;
  vscode.workspace.findFiles = async () => [vscode.Uri.file(csv)];
  vscode.workspace.fs = { readFile: async () => Buffer.from(K4_SUITE) };
  const connection = await startQ(t, dir);
  const explorer = registerTestExplorer(stub.newContext(), liveOn(connection), () => undefined);
  await explorer.discover();
  await explorer.run();
  const ours = explorer.results().map((r) => r.state === "passed");
  assert.deepStrictEqual(ours, k4, JSON.stringify(explorer.results()));
  // Not vacuous: the suite has a pass and a failure.
  assert.deepStrictEqual(k4, [true, true, true, false, true]);
});
