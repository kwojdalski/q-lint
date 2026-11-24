// List q Tables and Lint q Code (#951), the @q participant (#952) and Draft
// qSQL from a Description (#953) through the stand-in `vscode`
// (vscode_stub.js), with a stubbed language model and a stand-in for
// `Live`. What only a real model shows - whether its explanation or its
// query is any good - is not tested here: what is, is everything around it
// (the prompt, the reads, the tool calls and their confirmation token, the
// preview and its Run and Insert, and each feature turned off).
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}
class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}
class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}
Object.assign(vscode, {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelToolResult: class {
    constructor(content) {
      this.content = content;
    }
  },
  LanguageModelChatMessage: {
    User: (content) => ({ role: "user", content }),
    Assistant: (content) => ({ role: "assistant", content }),
  },
});
const registered = new Map();
const invoked = [];
let participants = [];
vscode.lm = {
  registerTool: (name, tool) => (registered.set(name, tool), { dispose: () => registered.delete(name) }),
  tools: [
    { name: "q-lint_runQuery", description: "run", inputSchema: {} },
    { name: "q-lint_listTables", description: "tables", inputSchema: {} },
    { name: "other_tool", description: "x", inputSchema: {} },
  ],
  invokeTool: async (name, options) => (invoked.push([name, options]), { content: [new LanguageModelTextPart('{"output":"6"}')] }),
  selectChatModels: async () => models,
};
vscode.chat = {
  createChatParticipant: (id, handler) => {
    const p = { id, handler, disposed: false, dispose() { this.disposed = true; } };
    participants.push(p);
    return p;
  },
};
let hovers = {};
const execute = vscode.commands.executeCommand;
vscode.commands.executeCommand = async (name, ...args) => (name === "vscode.executeHoverProvider" ? hovers[args[1].offset] ?? [] : execute(name, ...args));
vscode.languages.getDiagnostics = () => [{ range: { start: { line: 0 } }, code: "QF001", message: "a builtin as a parameter" }];
const documents = [];
vscode.workspace.openTextDocument = async ({ content, language }) => {
  let text = content;
  const n = documents.length;
  const d = { uri: { toString: () => `untitled:${n}` }, languageId: language, getText: () => text, set text(v) { text = v; } };
  documents.push(d);
  return d;
};
vscode.window.showTextDocument = async (d) => ({ document: d });

const { registerAssistTools, LISTED_TABLE_INFO } = require("../out/assisttools.js");
const { registerChat, converse } = require("../out/chat.js");
const { registerQsqlDraft } = require("../out/qsqldraft.js");
const { GATHER } = require("../out/explorer.js");
const { TABLE_INFO } = require("../out/tableinfo.js");
const { DESCRIBE } = require("../out/assist.js");

let models = [];
/// A model that answers each request with the next script of parts, and
/// keeps what it was sent.
function fakeModel(rounds) {
  const model = {
    name: "Fake",
    sent: [],
    sendRequest: async (messages, options) => {
      model.sent.push({ messages: structuredClone(messages), options });
      const parts = rounds.shift() ?? [];
      return {
        stream: (async function* () {
          yield* parts;
        })(),
        text: (async function* () {
          for (const p of parts) if (p instanceof LanguageModelTextPart) yield p.value;
        })(),
      };
    },
  };
  return model;
}

const dev = { label: "dev", host: "h", port: 1, tags: [] };
function fakeLive({ connected = true, history = [] } = {}) {
  const live = {
    sent: [],
    queried: [],
    activeLabel: () => (connected ? "dev" : undefined),
    activeProcess: () => (connected ? dev : undefined),
    processes: () => [dev],
    discovery: { discovered: () => [] },
    sharedList: () => [],
    history: () => history,
    queryCode: async (code, uri) => void live.queried.push([code, uri.toString()]),
    borrow: (use) =>
      connected
        ? use(
            {
              call: async (lambda, ...args) => {
                const name = lambda === GATHER ? "GATHER" : lambda === TABLE_INFO || lambda === LISTED_TABLE_INFO ? "TABLE_INFO" : lambda === DESCRIBE ? "DESCRIBE" : "?";
                live.sent.push([name, ...args]);
                if (name === "GATHER") {
                  return {
                    rows: [
                      { ns: ".", name: "trade", kind: "table", type: 98, count: 6, cols: ["date", "sym", "px"], keys: [], params: [], partitioned: true, ncols: 3 },
                      { ns: ".", name: "f", kind: "function", type: 100, count: null, cols: [], keys: [], params: ["x"], partitioned: false, ncols: 0 },
                    ],
                    spaces: [{ ns: ".", total: 2 }],
                    more: 0,
                  };
                }
                if (name === "TABLE_INFO") {
                  return { kind: "partitioned", rows: 6, bytes: null, partitions: 2, keys: [], ncols: 3, cols: ["date", "sym", "px"], types: ["d", "s", "f"], fkeys: ["", "", ""], attrs: ["", "p", ""] };
                }
                const names = args[0].split(" ");
                return { name: names, kind: names.map((n) => (n === "f" ? "lambda" : "missing")), type: names.map(() => 100), count: names.map(() => null), text: names.map((n) => (n === "f" ? "{x*2}" : "")) };
              },
            },
            dev,
          )
        : undefined,
  };
  return live;
}

function setup(settings = {}, liveOptions) {
  stub.reset();
  stub.config.user = { ...settings };
  registered.clear();
  invoked.length = 0;
  participants = [];
  documents.length = 0;
  hovers = {};
  vscode.window.activeTextEditor = undefined;
  const live = fakeLive(liveOptions);
  const context = stub.newContext();
  return { live, context };
}

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

test("List q Tables: the tables, one table's schema, reading only with the explorer's lambdas", async () => {
  const { live, context } = setup();
  const tools = registerAssistTools(context, live, () => []);
  assert.deepStrictEqual([...registered.keys()], ["q-lint_listTables", "q-lint_lint"]);
  assert.deepStrictEqual(await tools.tables.run({}), { process: "dev", tables: [{ name: "trade", kind: "partitioned", rows: 6, columns: ["date", "sym", "px"] }] });
  const schema = await tools.tables.run({ table: "trade" });
  assert.deepStrictEqual(schema.columns, [{ name: "date", type: "date" }, { name: "sym", type: "symbol", attribute: "parted" }, { name: "px", type: "float" }]);
  assert.deepStrictEqual(live.sent.map((s) => s[0]), ["GATHER", "TABLE_INFO"]);
  assert.match((await tools.tables.run({ process: "uat" })).error, /connected process, dev, only/);
  const none = setup({}, { connected: false });
  const t2 = registerAssistTools(none.context, none.live, () => []);
  assert.match((await t2.tables.run({})).error, /No q process is connected/);
});

test("List q Tables reads a plain table name only, asks first, and refuses a handle or expression (#1612)", async () => {
  const { live, context } = setup();
  const tools = registerAssistTools(context, live, () => []);
  for (const table of [":/data/db/huge", "`:/etc/passwd", "t;exit 0", "a b", "1t", ".ns..t"]) {
    assert.match((await tools.tables.run({ table })).error, /must be a table's name/, table);
  }
  assert.deepStrictEqual(live.sent, []);
  // The process checks the name is a table it lists before get.
  await tools.tables.run({ table: ".ns.trade" });
  assert.deepStrictEqual(live.sent, [["TABLE_INFO", ".ns.trade", 200]]);
  assert.match(LISTED_TABLE_INFO, /in@\[tables;/);
  // Asked before reading; read on another process than asked: refused.
  const prepared = tools.tables.prepareInvocation({ input: { table: "trade" } });
  assert.match(prepared.confirmationMessages.message.value, /`trade` on \*\*dev\*\*/);
  assert.strictEqual(tools.tables.prepareInvocation({ input: {} }).confirmationMessages, undefined);
  live.activeLabel = () => "uat";
  assert.match((await tools.tables.run({ table: "trade", process: "uat" })).error, /asked to read trade on dev/);
});

test("List q Tables takes a null process or table as left out (#1623)", async () => {
  const { live, context } = setup();
  const tools = registerAssistTools(context, live, () => []);
  assert.strictEqual((await tools.tables.run({ process: null, table: null })).tables.length, 1);
  assert.strictEqual((await tools.tables.run({ process: null, table: "trade" })).name, "trade");
});

test("Lint q Code: qlinter's findings on the code given as standard input", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-linttool-"));
  const fake = path.join(dir, "qlinter");
  // Echoes its arguments and input back as a finding.
  fs.writeFileSync(fake, '#!/bin/sh\ninput=$(cat)\nprintf \'[{"line":1,"column":2,"code":"QX","rule":"r","severity":"warning","detail":"%s","why":"%s"}]\' "$*" "$input"\nexit 1\n', { mode: 0o755 });
  const { live, context } = setup();
  const tools = registerAssistTools(context, live, () => ["/no/such/qlinter", fake]);
  const out = await tools.lint.run({ code: "f:{x}", file: "src/a.q" });
  assert.strictEqual(out.count, 1);
  assert.strictEqual(out.findings[0].message, "--format json --color never --stdin-filename src/a.q - f:{x}");
  // A file name that is not a workspace q path is not passed on.
  assert.match((await tools.lint.run({ code: "1", file: "../../etc/passwd" })).findings[0].message, /stdin-filename snippet\.q/);
  assert.match((await tools.lint.run({ code: 42 })).error, /"code" must be q code/);
  const failing = registerAssistTools(context, live, () => ["/no/such/qlinter"]);
  assert.match((await failing.lint.run({ code: "1" })).error, /Could not lint/);
  // The real binary, when it is built.
  const real = path.join(__dirname, "..", "..", "..", "target", "release", "qlinter");
  if (!fs.existsSync(real)) {
    t.diagnostic("no target/release/qlinter: the real binary is not run");
    return;
  }
  const realTools = registerAssistTools(context, live, () => [real]);
  const found = await realTools.lint.run({ code: "f:{[x;count] x+count}\n" });
  assert.ok(found.findings.some((f) => f.code === "QF001"), JSON.stringify(found));
  assert.deepStrictEqual(await realTools.lint.run({ code: "f:{[x] x+1}\n" }), { findings: [], count: 0 });
});

test("Lint q Code answers the first 200 findings, with their count (#1628)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-lintcap-"));
  const fake = path.join(dir, "qlinter");
  const one = '{"line":1,"column":1,"code":"QX","rule":"r","severity":"warning","detail":"d","why":"w"}';
  fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '[%s]' '${Array(500).fill(one).join(",")}'\nexit 1\n`, { mode: 0o755 });
  const { live, context } = setup();
  const out = await registerAssistTools(context, live, () => [fake]).lint.run({ code: "1" });
  assert.deepStrictEqual([out.findings.length, out.count, out.truncated], [200, 500, true]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Lint q Code reads qlinter's output whole, a character split across chunks too (#1380)", async () => {
  const { runWith } = require("../out/assisttools.js");
  const script = 'process.stdout.write("a".repeat(65535) + "\u00e9".repeat(10))';
  const ran = await runWith(process.execPath, ["-e", script], "", undefined, 10);
  assert.strictEqual(ran.stdout.slice(65535), "\u00e9".repeat(10));
});

test("Windows: Lint q Code runs a qlinter.cmd serverPath through a shell, as the server is started (#1816)", async (t) => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { runWith } = require("../out/assisttools.js");
  const cp = require("node:child_process");
  const { spawn } = cp;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const spawned = [];
  cp.spawn = (command, args, options) => {
    spawned.push({ command, args, shell: options.shell });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => {
    cp.spawn = spawn;
    Object.defineProperty(process, "platform", platform);
  });
  assert.strictEqual((await runWith("C:\\bin\\qlinter.cmd", ["--format", "json", "-"], "1", undefined, 10)).status, 0);
  assert.deepStrictEqual(spawned, [{ command: '"C:\\bin\\qlinter.cmd"', args: ['"--format"', '"json"', '"-"'], shell: true }]);
});

test("Lint q Code cancelled stops: the next qlinter is not started (#1381)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-lintcancel-"));
  const log = path.join(dir, "ran");
  const fake = (n) => {
    const f = path.join(dir, `qlinter${n}`);
    fs.writeFileSync(f, `#!/bin/sh\necho ${n} >> ${log}\nsleep 2\necho []\n`, { mode: 0o755 });
    return f;
  };
  const { live, context } = setup();
  const tools = registerAssistTools(context, live, () => [fake(1), fake(2)]);
  const listeners = [];
  const cancelling = { isCancellationRequested: false, onCancellationRequested: (f) => (listeners.push(f), { dispose() {} }) };
  // Cancelled once the first has started.
  const started = setInterval(() => {
    if (fs.existsSync(log)) {
      clearInterval(started);
      cancelling.isCancellationRequested = true;
      listeners.forEach((f) => f());
    }
  }, 20);
  assert.deepStrictEqual(await tools.lint.run({ code: "x:1" }, cancelling), { error: "Linting was cancelled." });
  assert.deepStrictEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["1"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the tools turned off: unregistered at once, and a call on its way is told so and sends nothing", async () => {
  const { live, context } = setup({ "agent.schemaTool.enable": false });
  const tools = registerAssistTools(context, live, () => []);
  assert.deepStrictEqual([...registered.keys()], ["q-lint_lint"]);
  assert.match((await tools.tables.run({})).error, /List q Tables agent tool is turned off\. Set q-lint\.agent\.schemaTool\.enable to true/);
  assert.deepStrictEqual(live.sent, []);
  stub.config.user["agent.lintTool.enable"] = false;
  stub.changeConfig("q-lint.agent.lintTool.enable");
  assert.deepStrictEqual(tools.registered(), []);
  assert.match((await tools.lint.run({ code: "1" })).error, /turned off/);
  stub.config.user["agent.schemaTool.enable"] = true;
  stub.changeConfig("q-lint.agent.schemaTool.enable");
  assert.deepStrictEqual(tools.registered(), ["q-lint_listTables"]);
});

test("@q explains a selection with the server's hovers and findings and the process's definitions, and its tool calls go through lm.invokeTool", async () => {
  const { live, context } = setup();
  const chat = registerChat(context, live);
  assert.strictEqual(participants.length, 1);
  assert.strictEqual(participants[0].id, "q-lint.q");
  const text = "f 3";
  const selection = { isEmpty: false, start: { line: 0 }, intersection: () => ({}) };
  vscode.window.activeTextEditor = {
    selection,
    document: { languageId: "q", uri: "file:///a.q", getText: () => text, offsetAt: () => 0, positionAt: (offset) => ({ offset }) },
  };
  hovers[0] = [{ contents: [{ value: "**f**[x]: doubles x" }] }];
  const model = fakeModel([
    [new LanguageModelTextPart("Let me run it. "), new LanguageModelToolCallPart("c1", "q-lint_runQuery", { query: "f 3" })],
    [new LanguageModelTextPart("It returns 6.")],
  ]);
  const said = [];
  const progress = [];
  const result = await chat.participant.handle(
    { prompt: "", command: undefined, model, toolInvocationToken: "TOKEN" },
    {},
    { markdown: (m) => said.push(m), progress: (p) => progress.push(p) },
    token,
  );
  assert.deepStrictEqual(result, { metadata: { command: undefined } });
  assert.strictEqual(said.join(""), "Let me run it. It returns 6.");
  const prompt = model.sent[0].messages[0].content;
  assert.match(prompt, /```q\nf 3\n```/);
  assert.match(prompt, /- `f`: \*\*f\*\*\[x\]: doubles x/);
  assert.match(prompt, /- line 1: QF001 a builtin as a parameter/);
  assert.match(prompt, /On the connected q process dev:\n- `f`: a function defined on the process as:\n```q\n\{x\*2\}\n```/);
  // Only q-lint's tools are offered; the call went through VS Code, with the chat's token, which asks the user to confirm.
  assert.deepStrictEqual(model.sent[0].options.tools.map((t) => t.name), ["q-lint_runQuery", "q-lint_listTables"]);
  assert.deepStrictEqual(invoked, [["q-lint_runQuery", { input: { query: "f 3" }, toolInvocationToken: "TOKEN" }]]);
  assert.deepStrictEqual(model.sent[1].messages.at(-1).content[0].callId, "c1");
  // The participant itself sent only DESCRIBE, which reads.
  assert.deepStrictEqual(live.sent, [["DESCRIBE", "f"]]);
});

test("@q offers no tools in its last round and runs none of that round's calls (#1615)", async () => {
  setup();
  const call = () => [new LanguageModelToolCallPart("c", "q-lint_runQuery", { query: "1" })];
  const model = fakeModel([call(), call(), call(), call(), call()]);
  const said = [];
  await converse(model, "p", { markdown: (m) => said.push(m) }, token, "TOKEN");
  assert.strictEqual(model.sent.length, 5);
  assert.strictEqual(invoked.length, 4);
  assert.strictEqual(model.sent[4].options.tools, undefined);
  assert.match(said.join(""), /Stopped after 5 rounds of tool calls/);
});

test("@q turned off mid-request sends no more requests and runs no more tools (#1632)", async () => {
  setup();
  const call = () => [new LanguageModelToolCallPart("c", "q-lint_runQuery", { query: "1" })];
  const model = fakeModel([call(), call(), call()]);
  const send = model.sendRequest;
  model.sendRequest = async (...args) => {
    const r = await send(...args);
    stub.config.user["chat.participant.enable"] = false;
    return r;
  };
  const said = [];
  await converse(model, "p", { markdown: (m) => said.push(m) }, token, "TOKEN");
  assert.strictEqual(model.sent.length, 1);
  assert.strictEqual(invoked.length, 0);
  assert.match(said.join(""), /turned off/);
});

test("@q /error explains the last failed query, or the error typed", async () => {
  const history = [
    { process: "dev", code: "1+`a", outcome: "error", error: "type", at: "", millis: 1 },
    { process: "dev", code: "f 1", outcome: "ok", at: "", millis: 1 },
  ];
  const { live, context } = setup({}, { history });
  const chat = registerChat(context, live);
  const model = fakeModel([[new LanguageModelTextPart("A type error.")]]);
  await chat.participant.handle({ prompt: "", command: "error", model }, {}, { markdown() {}, progress() {} }, token);
  assert.match(model.sent[0].messages[0].content, /Explain this q error and how to fix it: `'type`[\s\S]*run on dev:\n```q\n1\+`a\n```/);
  // A query that failed on another process: its names are not described
  // from the active one under its label (#1377).
  const other = setup({}, { history: [{ process: "rdb", code: "f 1", outcome: "error", error: "type", at: "", millis: 1 }] });
  const m3 = fakeModel([[new LanguageModelTextPart("A type error.")]]);
  await registerChat(other.context, other.live).participant.handle({ prompt: "", command: "error", model: m3 }, {}, { markdown() {}, progress() {} }, token);
  assert.deepStrictEqual(other.live.sent, []);
  assert.doesNotMatch(m3.sent[0].messages[0].content, /\{x\*2\}/);
  const same = setup({}, { history: [{ process: "dev", code: "f 1", outcome: "error", error: "type", at: "", millis: 1 }] });
  const m4 = fakeModel([[new LanguageModelTextPart("A type error.")]]);
  await registerChat(same.context, same.live).participant.handle({ prompt: "", command: "error", model: m4 }, {}, { markdown() {}, progress() {} }, token);
  assert.match(m4.sent[0].messages[0].content, /\{x\*2\}/);
  const empty = setup({}, { history: [] });
  const said = [];
  const m2 = fakeModel([]);
  await registerChat(empty.context, empty.live).participant.handle({ prompt: "", command: "error", model: m2 }, {}, { markdown: (m) => said.push(m), progress() {} }, token);
  assert.match(said[0], /No query in Query History failed/);
  assert.strictEqual(m2.sent.length, 0);
});

test("@q turned off: disposed at once, a request is told so, and neither model nor process is asked", async () => {
  const { live, context } = setup();
  const chat = registerChat(context, live);
  stub.config.user["chat.participant.enable"] = false;
  stub.changeConfig("q-lint.chat.participant.enable");
  assert.strictEqual(participants[0].disposed, true);
  assert.strictEqual(chat.registered(), false);
  const said = [];
  const model = fakeModel([]);
  await chat.participant.handle({ prompt: "f 3", model }, {}, { markdown: (m) => said.push(m), progress() {} }, token);
  assert.match(said[0], /@q chat participant is turned off\. Set q-lint\.chat\.participant\.enable to true/);
  assert.strictEqual(model.sent.length, 0);
  assert.deepStrictEqual(live.sent, []);
});

test("Draft qSQL shows the draft for review and runs nothing until Run, then runs the text as edited", async () => {
  const { live, context } = setup();
  registerQsqlDraft(context, live);
  const model = fakeModel([[new LanguageModelTextPart("```q\nselect last px by sym from trade\n```")]]);
  models = [model];
  // The user edits the draft before pressing Run.
  stub.picks = [(o) => ((stub.offered = o.items), (documents[0].text = documents[0].getText().replace("last px", "max px")), "Run")];
  const out = await stub.commands.get("q-lint.draftQsql")("the last price of each sym");
  assert.strictEqual(out.code, "select last px by sym from trade");
  assert.match(model.sent[0].messages[0].content, /- trade \(partitioned, 6 rows\): date, sym, px[\s\S]*Write a query for: the last price of each sym$/);
  assert.match(documents[0].getText(), /^\/ Drafted by Fake from: the last price of each sym\n/);
  assert.deepStrictEqual(stub.offered, ["Run"]);
  assert.deepStrictEqual(live.queried, [["select max px by sym from trade", "untitled:0"]]);
  assert.deepStrictEqual(live.sent.map((s) => s[0]), ["GATHER"]);

  // Dismissed: nothing runs. Insert at Cursor puts it into the editor it started from.
  const second = setup();
  registerQsqlDraft(second.context, second.live);
  const edits = [];
  vscode.window.activeTextEditor = { document: { languageId: "q" }, selection: "SEL", edit: async (f) => f({ replace: (at, text) => edits.push([at, text]) }) };
  models = [fakeModel([[new LanguageModelTextPart("exec 1 from t")]])];
  stub.picks = [undefined];
  await stub.commands.get("q-lint.draftQsql")("one");
  assert.deepStrictEqual(second.live.queried, []);
  models = [fakeModel([[new LanguageModelTextPart("exec 1 from t")]])];
  stub.picks = [(o) => ((stub.offered = o.items), "Insert at Cursor")];
  await stub.commands.get("q-lint.draftQsql")("one");
  assert.deepStrictEqual(stub.offered, ["Run", "Insert at Cursor"]);
  assert.deepStrictEqual(edits, [["SEL", "exec 1 from t"]]);
  assert.deepStrictEqual(second.live.queried, []);
});

test("Insert at Cursor shows the source document again when its editor was closed meanwhile, and says when it cannot (#1906)", async (t) => {
  const { live, context } = setup();
  registerQsqlDraft(context, live);
  const show = vscode.window.showTextDocument;
  t.after(() => ((vscode.window.showTextDocument = show), (vscode.window.activeTextEditor = undefined)));
  // The editor the command started from, its tab no longer shown: VS Code's own refusal.
  const source = { languageId: "q", uri: { toString: () => "file:///w/a.q" } };
  const closed = {
    document: source,
    selection: "SEL",
    viewColumn: 2,
    edit: () => {
      throw new Error("TextEditor#edit not possible on closed editors");
    },
  };
  const edits = [];
  const shown = [];
  vscode.window.showTextDocument = async (d, options) => {
    if (d !== source) return show(d, options);
    shown.push(options);
    return { document: d, selection: options.selection, edit: async (f) => (f({ replace: (at, text) => edits.push([at, text]) }), true) };
  };
  const insert = async () => {
    vscode.window.activeTextEditor = closed;
    models = [fakeModel([[new LanguageModelTextPart("exec 1 from t")]])];
    stub.picks = ["Insert at Cursor"];
    return stub.commands.get("q-lint.draftQsql")("one");
  };
  assert.strictEqual((await insert()).picked, "Insert at Cursor");
  assert.deepStrictEqual(shown, [{ viewColumn: 2, selection: "SEL" }]);
  assert.deepStrictEqual(edits, [["SEL", "exec 1 from t"]]);
  // The document is gone too: said, not thrown.
  vscode.window.showTextDocument = async (d, options) => {
    if (d !== source) return show(d, options);
    throw new Error("cannot open file:///w/a.q");
  };
  assert.strictEqual((await insert()).picked, "Insert at Cursor");
  assert.deepStrictEqual(stub.messages.at(-1), ["error", "q-lint: the draft was not inserted: cannot open file:///w/a.q. It is still in its own editor."]);
  assert.strictEqual(edits.length, 1);
});

test("@q explain and Draft qSQL read nothing from a process switched to mid-request (#1621)", async () => {
  const { live, context } = setup();
  const chat = registerChat(context, live);
  // The connection moves to uat before the read borrows it.
  const borrow = live.borrow;
  live.activeLabel = () => "dev";
  live.borrow = (use) => ((live.activeLabel = () => "uat"), borrow((c) => use(c, { ...dev, label: "uat" })));
  const asked = await chat.participant.prompt({ prompt: "f 3", command: undefined });
  assert.doesNotMatch(asked.prompt, /\{x\*2\}/);
  assert.deepStrictEqual(live.sent, []);
  const second = setup();
  registerQsqlDraft(second.context, second.live);
  second.live.borrow = (use) => ((second.live.activeLabel = () => "uat"), fakeLive().borrow((c) => use(c, { ...dev, label: "uat" })));
  const model = fakeModel([[new LanguageModelTextPart("exec 1 from t")]]);
  models = [model];
  stub.picks = [undefined];
  await stub.commands.get("q-lint.draftQsql")("one");
  assert.doesNotMatch(model.sent[0].messages[0].content, /trade/);
});

test("Draft qSQL turned off, or with no model: refuses and asks neither model nor process", async () => {
  const { live, context } = setup({ "chat.englishToQsql.enable": false });
  registerQsqlDraft(context, live);
  const model = fakeModel([]);
  models = [model];
  assert.strictEqual(await stub.commands.get("q-lint.draftQsql")("x"), undefined);
  assert.match(stub.messages[0][1], /Draft qSQL from a Description is turned off\. Set q-lint\.chat\.englishToQsql\.enable to true/);
  assert.strictEqual(model.sent.length, 0);
  assert.deepStrictEqual(live.sent, []);
  const on = setup();
  registerQsqlDraft(on.context, on.live);
  models = [];
  assert.strictEqual(await stub.commands.get("q-lint.draftQsql")("x"), undefined);
  assert.match(stub.messages[0][1], /no language model is available/);
  assert.deepStrictEqual(on.live.sent, []);
});

test("Lint q Code lints a file of another workspace folder in that folder, so its configuration applies (#1838)", () => {
  const { lintPlace } = require("../out/assisttools.js");
  const folders = [{ name: "A", path: "/ws/A" }, { name: "B", path: "/ws/B" }];
  // VS Code's multi-root workspace-relative form names the folder first.
  assert.deepStrictEqual(lintPlace("B/src/x.q", folders, undefined), { cwd: "/ws/B", file: "src/x.q" });
  // Without one: the active editor's folder, else the first.
  assert.deepStrictEqual(lintPlace("src/x.q", folders, "/ws/B"), { cwd: "/ws/B", file: "src/x.q" });
  assert.deepStrictEqual(lintPlace("src/x.q", folders, undefined), { cwd: "/ws/A", file: "src/x.q" });
  // One folder: a path is never read as naming it.
  assert.deepStrictEqual(lintPlace("A/x.q", [folders[0]], undefined), { cwd: "/ws/A", file: "A/x.q" });
  assert.deepStrictEqual(lintPlace("snippet.q", [], undefined), { cwd: undefined, file: "snippet.q" });
});
