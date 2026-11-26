// The Run q Query tool around `agent.ts` (#886): which process a call runs
// on, and its timeout and cancellation, with VS Code and the live half
// replaced by stand-ins. Run after `tsc`; agent_q.test.js runs the query
// itself against a real q.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// The few parts of `vscode` agenttool.ts touches, and the tool it registers.
let tool;
let settings = {};
const configListeners = [];
const vscode = {
  commands: { registerCommand: () => ({ dispose() {} }) },
  lm: {
    registerTool: (_name, t) => {
      tool = t;
      return { dispose() {} };
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
    onDidChangeConfiguration: (f) => (configListeners.push(f), { dispose() {} }),
  },
  window: { showInformationMessage() {}, setStatusBarMessage() {} },
  env: { clipboard: { writeText: async () => {} } },
  MarkdownString: class {
    constructor(value) {
      this.value = value;
    }
  },
  LanguageModelTextPart: class {
    constructor(value) {
      this.value = value;
    }
  },
  LanguageModelToolResult: class {
    constructor(content) {
      this.content = content;
    }
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};
const { registerAgentTool } = require("../out/agenttool.js");
Module._load = load;
const { guardCheck, guardRefusal, readGuard } = require("../out/guard.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = { label: "dev", host: "d", port: 1, tags: ["dev"] };
const prod = { label: "prod", host: "p", port: 2, tags: ["prod"] };

/// A stand-in for `Live`: `active` is connected, and `runOnActive` waits
/// `wait` ms - as it does behind the Process Explorer's read of the
/// process - before it hands the query the connection. A query that has
/// started runs until it is aborted.
function fakeLive({ active, wait = 0, during, shared = [] } = {}) {
  const live = {
    active,
    ran: [],
    aborted: 0,
    records: [],
    processes: () => [dev, prod],
    discovery: { discovered: () => [] },
    sharedList: () => shared,
    activeLabel: () => live.active?.label,
    activeProcess: () => live.active,
    // No TorQ gateway here: statements go as written.
    gatewayed: (cut) => ({ cut, plain: false }),
    connectTo: async (label) => {
      live.active = [dev, prod].find((p) => p.label === label);
      return live.active !== undefined;
    },
    abort: async () => {
      live.aborted++;
      live.stop?.(new Error("the connection closed before the process answered"));
    },
    record: async (entry) => {
      live.records.push(entry);
    },
    guardRefuses: (code, targets) => {
      const check = guardCheck(code, targets, readGuard((key, fallback) => settings[key] ?? fallback));
      return check === undefined ? undefined : guardRefusal(check);
    },
    runOnActive: async (code, query, _guard, _expect, signal) => {
      // Stopped while it waits, as Live.ready stops a waiter: nothing is run.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
      if (signal?.aborted) {
        return undefined;
      }
      during?.(live);
      const connection = {
        queryGrid: () => {
          live.ran.push(`${live.active.label}: ${code}`);
          return new Promise((_, reject) => {
            live.stop = reject;
          });
        },
      };
      return { process: live.active.label, value: await query(connection) };
    },
  };
  return live;
}

function token() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested: (f) => {
      listeners.push(f);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      listeners.forEach((f) => f());
    },
  };
}

function register(live) {
  tool = undefined;
  registerAgentTool({ subscriptions: [] }, live);
  return tool;
}

/// `promise`, or "still waiting" after `ms`.
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => "still waiting")]);

test("a timeout that passes while the query waits for the connection still stops it", async () => {
  settings = { "agent.queryTimeout": 1 };
  const live = fakeLive({ active: dev, wait: 1300 });
  const result = await within(register(live).run({ query: "slow 100" }, token()), 3000);
  assert.notStrictEqual(result, "still waiting", "the query ran on past its timeout");
  assert.match(result.error, /1 s/);
  assert.deepStrictEqual(live.ran, [], "a query whose time was up before it started was sent");
});

test("the timeout and Cancel end the wait for a busy connection, not only what follows it (#2551)", async () => {
  settings = { "agent.queryTimeout": 1 };
  const live = fakeLive({ active: dev, wait: 8000 });
  const started = Date.now();
  const result = await within(register(live).run({ query: "slow 100" }, token()), 2500);
  assert.notStrictEqual(result, "still waiting", "the tool waited for the process to be free");
  assert.match(result.error, /waited longer than 1 s/);
  assert.ok(Date.now() - started < 2500);
  settings = { "agent.queryTimeout": 0 };
  const t = token();
  const running = register(fakeLive({ active: dev, wait: 8000 })).run({ query: "slow 100" }, t);
  await sleep(50);
  t.cancel();
  assert.match((await within(running, 1000)).error, /cancelled before it ran/);
  assert.deepStrictEqual(live.ran, []);
});

test("a cancellation while the query waits for the connection keeps it from running", async () => {
  settings = { "agent.queryTimeout": 0 };
  const live = fakeLive({ active: dev, wait: 300 });
  const t = token();
  const running = register(live).run({ query: "delete from `trades" }, t);
  await sleep(50);
  t.cancel();
  const result = await within(running, 2000);
  assert.notStrictEqual(result, "still waiting");
  assert.match(result.error, /cancelled/);
  assert.deepStrictEqual(live.ran, []);
});

test("a query runs only on the process the user confirmed", async () => {
  settings = { "agent.queryTimeout": 0 };
  // Asked with dev active; the user connects to prod before answering.
  const live = fakeLive({ active: dev });
  const t = register(live);
  const input = { query: "select from trades" };
  const asked = t.prepareInvocation({ input });
  assert.strictEqual(asked.confirmationMessages.title, "Run a q query on dev?");
  live.active = prod;
  const result = await within(t.run({ ...input }, token()), 2000);
  assert.deepStrictEqual(live.ran, []);
  assert.match(result.error, /dev/);
  assert.match(result.error, /prod/);
});

test("a process on the shared list is named by the label Copy Label for Agent Query copies (#1819)", () => {
  settings = { "agent.queryTimeout": 0 };
  const rdb = { label: "rdb", host: "h", port: 5010, tags: [] };
  const shared = [{ server: { label: ".qlint", url: "file:///w/.vscode/q-processes.json" }, state: { processes: [rdb], problems: [], loading: false, fetchedAt: 1 } }];
  const t = register(fakeLive({ active: dev, shared }));
  const asked = t.prepareInvocation({ input: { query: "count trade", process: ".qlint/rdb" } });
  assert.match(asked.confirmationMessages.title, /rdb/);
});

test("nor on one the connection moved to while the query waited for it", async () => {
  settings = { "agent.queryTimeout": 0 };
  const live = fakeLive({ active: dev, wait: 50, during: (l) => (l.active = prod) });
  const t = register(live);
  const input = { query: "delete from `trades" };
  t.prepareInvocation({ input });
  const result = await within(t.run(input, token()), 2000);
  assert.deepStrictEqual(live.ran, []);
  assert.match(result.error, /prod/);
});

test("a query confirmed on the process it runs on runs, and its timeout aborts it", async () => {
  settings = { "agent.queryTimeout": 1 };
  const live = fakeLive({ active: dev });
  const t = register(live);
  const input = { query: "slow 100" };
  t.prepareInvocation({ input });
  const result = await within(t.run(input, token()), 3000);
  assert.deepStrictEqual(live.ran, ["dev: slow 100"]);
  assert.strictEqual(live.aborted, 1);
  assert.match(result.error, /ran longer than 1 s/);
});

test("an input of the wrong type is answered with an error, not a crash", async () => {
  // A model can send a port for `process`, or a list for `query`; the schema
  // asks for strings, and nothing checks it before the tool is called.
  settings = { "agent.queryTimeout": 0 };
  const live = fakeLive({ active: dev });
  const t = register(live);
  for (const input of [{ query: "1+1", process: 5001 }, { query: ["1+1"] }, { query: 7 }]) {
    assert.doesNotThrow(() => t.prepareInvocation({ input }), JSON.stringify(input));
    const result = await within(t.run(input, token()), 2000);
    assert.ok(typeof result.error === "string", JSON.stringify(result));
  }
  assert.deepStrictEqual(live.ran, []);
});

test("a call the user was not asked about does not run once it could", async () => {
  // Prepared when nothing was connected, so VS Code asked nothing; the
  // user connects before the call is invoked.
  settings = { "agent.queryTimeout": 0 };
  const live = fakeLive({});
  const t = register(live);
  const input = { query: "select from trades" };
  const asked = t.prepareInvocation({ input });
  assert.strictEqual(asked.confirmationMessages, undefined);
  live.active = prod;
  const result = await within(t.run({ ...input }, token()), 2000);
  assert.deepStrictEqual(live.ran, []);
  assert.match(result.error, /not asked|Ask again/);
});

test("a call cancelled before it runs does not connect to its process", async () => {
  settings = { "agent.queryTimeout": 0 };
  const live = fakeLive({ active: dev });
  const t = register(live);
  const input = { query: "1+1", process: "prod" };
  t.prepareInvocation({ input });
  const cancelled = token();
  cancelled.cancel();
  const result = await within(t.run(input, cancelled), 2000);
  assert.match(result.error, /cancelled/);
  assert.strictEqual(live.active, dev, "the active connection was switched for a cancelled call");
});

// The read-only guard (#918): an agent cannot be asked, so a query that
// would change a guarded process is refused, and the user is not offered it.
test("a query that would change a read-only process is refused, unasked and unsent", async () => {
  settings = { "agent.queryTimeout": 0 };
  const live = fakeLive({ active: prod });
  const t = register(live);
  const input = { query: "delete from `trades" };
  assert.strictEqual(t.prepareInvocation({ input }).confirmationMessages, undefined);
  const result = await within(t.run({ ...input }, token()), 2000);
  assert.match(result.error, /^Nothing was run: prod is read-only guarded \(tagged prod; q-lint.processes.readOnlyGuard.tags\), and the query deletes from `trades in place\./);
  assert.deepStrictEqual(live.ran, []);
  // Named, the process is not connected to either.
  const named = fakeLive({ active: dev });
  const result2 = await within(register(named).run({ query: "a:1", process: "prod" }, token()), 2000);
  assert.match(result2.error, /read-only guarded/);
  assert.strictEqual(named.active, dev);
  // A query that reads runs; so does any, with the guard off.
  const reads = fakeLive({ active: prod });
  const t2 = register(reads);
  const select = { query: "select from trades" };
  assert.ok(t2.prepareInvocation({ input: select }).confirmationMessages);
  settings = { "agent.queryTimeout": 0, "processes.readOnlyGuard.enable": false };
  const off = fakeLive({ active: prod });
  const t3 = register(off);
  assert.ok(t3.prepareInvocation({ input }).confirmationMessages);
});

test("turned off, the tool is unregistered and a call on its way runs nothing (#1624)", async () => {
  settings = { "agent.queryTool.enable": false };
  const live = fakeLive({ active: dev });
  tool = undefined;
  const handle = registerAgentTool({ subscriptions: [] }, live);
  assert.strictEqual(tool, undefined);
  assert.strictEqual(handle.registered(), false);
  settings = {};
  configListeners.forEach((f) => f({ affectsConfiguration: (k) => k === "q-lint.agent.queryTool.enable" }));
  assert.strictEqual(handle.registered(), true);
  settings = { "agent.queryTool.enable": false };
  configListeners.forEach((f) => f({ affectsConfiguration: (k) => k === "q-lint.agent.queryTool.enable" }));
  assert.strictEqual(handle.registered(), false);
  assert.match((await tool.run({ query: "1+1" }, token())).error, /Run q Query agent tool is turned off\. Set q-lint\.agent\.queryTool\.enable to true/);
  assert.deepStrictEqual(live.ran, []);
});
