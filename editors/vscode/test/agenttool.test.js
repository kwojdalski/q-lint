// The Run q Query tool around `agent.ts` (#886): its timeout and
// cancellation, with VS Code and the live half
// replaced by stand-ins. Run after `tsc`; agent_q.test.js runs the query
// itself against a real q.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// The few parts of `vscode` agenttool.ts touches, and the tool it registers.
let tool;
let settings = {};
const vscode = {
  commands: { registerCommand: () => ({ dispose() {} }) },
  lm: {
    registerTool: (_name, t) => {
      tool = t;
      return { dispose() {} };
    },
  },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = { label: "dev", host: "d", port: 1, tags: ["dev"] };
const prod = { label: "prod", host: "p", port: 2, tags: ["prod"] };

/// A stand-in for `Live`: `active` is connected, and `runOnActive` waits
/// `wait` ms - as it does behind the Process Explorer's read of the
/// process - before it hands the query the connection. A query that has
/// started runs until it is aborted.
function fakeLive({ active, wait = 0, during } = {}) {
  const live = {
    active,
    ran: [],
    aborted: 0,
    records: [],
    processes: () => [dev, prod],
    discovery: { discovered: () => [] },
    activeLabel: () => live.active?.label,
    activeProcess: () => live.active,
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
    runOnActive: async (code, query) => {
      await sleep(wait);
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
