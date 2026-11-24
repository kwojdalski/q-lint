// The language and linter features of #1052-#1061 in the editor: their
// switches, each command refusing when its feature is off and sending
// nothing, and what each does on. The server's side of #1052, #1053 and
// #1055-#1060 is tested in the Rust suite (tests/functional.rs,
// tests/annotations.rs, tests/baseline_target.rs); the q side in
// languagetools_q.test.js.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { LANGUAGE_SETTINGS, LANGUAGE_COMMANDS, languageOn, languageOff, NAMESPACES_VIEW } = require("../out/languagefeatures.js");
const { registerQsqlTools, leadBefore, REWRITE_TITLES } = require("../out/qsqltools.js");
const { ERRORS, errorName, explainError, errorInMessage, failedAt } = require("../out/errorexplain.js");
const { registerErrorExplainer } = require("../out/errorexplainview.js");
const { tomlWithBaseline, writtenCount, rebased, absolutePaths, registerBaseline, pyprojectWithBaseline, governingConfiguration } = require("../out/baselineview.js");
const { readDeadCode, deadCodeReport, registerDeadCode, DEAD_CODE } = require("../out/deadcodeview.js");
const { readDefinitions, byNamespace, registerNamespaces, DEFINITIONS } = require("../out/namespaceview.js");
const { affectedIds, registerAffectedOnSave, TESTS_REACHING } = require("../out/affectedonsave.js");
const { sqlQuery, sqlText, sqlWrites, readSchema, sqlCompletions } = require("../out/sql.js");
const { registerSql } = require("../out/sqlview.js");
const { launch } = require("../out/settings.js");

const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
const palette = (command) => pkg.contributes.menus.commandPalette.find((m) => m.command === command);

test("every switch is declared with its default, read as declared, and hides its commands", () => {
  for (const [feature, { key, fallback }] of Object.entries(LANGUAGE_SETTINGS)) {
    assert.strictEqual(props[`q-lint.${key}`]?.default, fallback, key);
    assert.strictEqual(languageOn(() => undefined, feature), fallback);
    assert.strictEqual(languageOn((k, d) => (k === key ? !fallback : d), feature), !fallback);
    assert.strictEqual(languageOn((k, d) => (k === key ? "yes" : d), feature), fallback);
    assert.match(languageOff(feature), new RegExp(`Set q-lint\\.${key.replace(/\./g, "\\.")} to true`));
  }
  // What sends code on its own is off by default.
  assert.strictEqual(LANGUAGE_SETTINGS.affectedTestsOnSave.fallback, false);
  assert.strictEqual(LANGUAGE_SETTINGS.deadCodeProcess.fallback, false);
  const gate = {
    toFunctional: "functionalForm.enable",
    toQsql: "functionalForm.enable",
    explainQsql: "qsqlExplain.enable",
    explainError: "errorExplain.enable",
    writeBaseline: "baseline.enable",
    deadCode: "deadCode.enable",
    namespacesRefresh: "namespaceTree.enable",
    newSql: "sql.enable",
    runSql: "sql.enable",
  };
  for (const [name, key] of Object.entries(gate)) {
    const command = LANGUAGE_COMMANDS[name];
    assert.ok(pkg.contributes.commands.some((c) => c.command === command && c.category === "q-lint"), command);
    assert.match(palette(command).when, new RegExp(`config\\.q-lint\\.${key.replace(/\./g, "\\.")}`), command);
  }
  const view = pkg.contributes.views.explorer.find((v) => v.id === NAMESPACES_VIEW);
  assert.match(view.when, /config\.q-lint\.namespaceTree\.enable/);
  // The server's switches reach it, and restart it.
  const l = launch({ get: (k, d) => (k === "versionCheck.enable" ? false : d), inspect: () => ({}) }, undefined);
  assert.deepStrictEqual(l.initializationOptions.versionCheck, { enable: false });
  assert.deepStrictEqual(l.initializationOptions.functionalForm, { enable: true });
});

// A context and a vscode with what these commands touch.
const row1 = (p) => `{"code":"QS001","count":1,"line":"a","path":"${p}"}`;

function setUp() {
  stub.reset();
  const context = stub.newContext();
  const ran = [];
  const shown = [];
  const execute = vscode.commands.executeCommand;
  vscode.window.showTextDocument = async (doc) => (shown.push(doc), {});
  vscode.workspace.openTextDocument = async (spec) => spec;
  return { context, ran, shown, restore: () => ((vscode.commands.executeCommand = execute), (vscode.window.activeTextEditor = undefined)) };
}

test("the qSQL rewrites refuse when off, and apply the server's action when on", async () => {
  const { context, ran, restore } = setUp();
  const applied = [];
  vscode.CodeActionKind = { RefactorRewrite: { value: "refactor.rewrite" } };
  vscode.Range = class {};
  vscode.workspace.applyEdit = async (edit) => (applied.push(edit), true);
  const execute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (name, ...args) =>
    name.startsWith("q-lint.") ? execute(name, ...args) : (ran.push(name), [{ title: REWRITE_TITLES.toFunctional, edit: "the edit" }]);
  try {
    registerQsqlTools(context);
    vscode.window.activeTextEditor = { document: { languageId: "q" }, selection: { active: {} } };
    stub.config.user["functionalForm.enable"] = false;
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.toFunctional)(), false);
    assert.match(stub.messages.at(-1)[1], /Rewriting qSQL to and from functional form is turned off/);
    assert.deepStrictEqual(ran, []);
    stub.config.user["functionalForm.enable"] = true;
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.toFunctional)(), true);
    assert.deepStrictEqual(applied, ["the edit"]);
    // None titled so: nothing applied, and it says why.
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.toQsql)(), false);
    assert.match(stub.messages.at(-1)[1], /not in a functional form/);
    stub.config.user["qsqlExplain.enable"] = false;
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.explainQsql)(), false);
    assert.match(stub.messages.at(-1)[1], /qSQL explainer is turned off/);
  } finally {
    restore();
  }
});

test("Explain qSQL finds where the query starts", () => {
  const text = "a:1\nr:select n:count i\n    by sym\n  from t where px>2\nb:2\n";
  assert.strictEqual(leadBefore(text, text.indexOf("px>2")), text.indexOf("select"));
  assert.strictEqual(leadBefore(text, text.indexOf("a:1")), undefined);
  assert.strictEqual(leadBefore(text, text.indexOf("b:2")), undefined);
  const f = "r:?[t;enlist(>;`px;2);0b;()]\n";
  assert.strictEqual(leadBefore(f, f.indexOf("px")), 2);
  // A name ending in a query word is no query.
  assert.strictEqual(leadBefore("x:.my.select 1\n", 10), undefined);
  // An empty first line above an indented one ends the walk (#1396).
  assert.strictEqual(leadBefore("\n  select from t", 10), 3);
  // A query word in a string or a comment is no lead (#1466).
  const s = 'select from trade where sym like "update*"';
  assert.strictEqual(leadBefore(s, s.length), 0);
  const c = "exec price from trade / then delete it";
  assert.strictEqual(leadBefore(c, c.length), 0);
});

test("a q error is explained from the catalogue, with the operation that failed", () => {
  assert.strictEqual(errorName("'type"), "type");
  assert.strictEqual(errorName("2026.11.22T19:23:04.352 length"), "length");
  assert.strictEqual(errorName("data.csv. OS reports: No such file or directory"), "os");
  assert.strictEqual(errorName("hop. OS reports: Connection refused"), "hop");
  const trace = ["  [2]  /w/lib.q:5: mid:{[a]", "    b:a+1;", "    c:b+`x;", "       ^", "    d:c*2}"].join("\n");
  const text = explainError("type", trace);
  assert.match(text, /# q error `'type`/);
  assert.match(text, /An argument is of a type the operation does not take/);
  assert.match(text, /The operation that failed in `mid` \(\/w\/lib\.q, line 5\): ``c:b\+`x;``, at `\+`\./);
  // A run of two backticks is held by a longer run (#1312).
  const pair = ["  [1]  /w/lib.q:2: f:{[a]", "    a,``b}", "     ^"].join("\n");
  assert.match(failedAt(pair), /: ```a,``b}```, at `,`\./);
  assert.match(failedAt(trace), /at `\+`/);
  assert.match(explainError("undefinedname123"), /`undefinedname123` is not defined where it was read/);
  assert.match(explainError("x.csv. OS reports: No such file"), /operating system refused/);
  assert.match(explainError("@@@"), /no explanation/);
  assert.strictEqual(errorInMessage("`s+1` is 'type: `s` is always a symbol here"), "type");
  assert.strictEqual(errorInMessage("no q error here, it's fine"), undefined);
  for (const [name, e] of Object.entries(ERRORS)) {
    assert.ok(e.meaning && e.causes.length > 0, name);
  }
});

test("Explain q Error prefers the selection, and forgets a failure once a later query answers (#1231)", async () => {
  const { context, restore } = setUp();
  vscode.languages.registerCodeActionsProvider = () => ({ dispose() {} });
  const history = [{ process: "p", code: "1+`a", outcome: "error" }];
  const live = { lastFailure: { process: "p", code: "1+`a", error: "type", trace: "" }, history: () => history };
  try {
    stub.config.user["errorExplain.enable"] = true;
    registerErrorExplainer(context, live);
    const explain = () => stub.commands.get(LANGUAGE_COMMANDS.explainError)();
    assert.match(await explain(), /'type/);
    // A selection wins over the failure.
    vscode.window.activeTextEditor = { selection: { isEmpty: false }, document: { getText: () => "'length" } };
    assert.match(await explain(), /'length/);
    vscode.window.activeTextEditor = undefined;
    // A query that answered since: the failure is not explained, the box asks.
    history.unshift({ process: "p", code: "1+1", outcome: "ok" });
    stub.inputs.push("'rank");
    assert.match(await explain(), /'rank/);
  } finally {
    vscode.window.activeTextEditor = undefined;
    restore();
  }
});

test("an error named after an Object.prototype member is an undefined name, not a crash (#1078)", () => {
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.match(explainError(`'${name}`), new RegExp(`\`${name}\` is not defined where it was read`), name);
    assert.strictEqual(errorInMessage(`fails with '${name} here`), undefined, name);
  }
});

test("Explain q Error refuses when off, and explains the last failure or the one given when on", async () => {
  const { context, shown, restore } = setUp();
  const providers = [];
  vscode.languages.registerCodeActionsProvider = (_sel, provider) => (providers.push(provider), { dispose: () => providers.splice(providers.indexOf(provider), 1) });
  try {
    const history = [{ process: "p", code: "1+`a", outcome: "error" }];
    const live = { lastFailure: { process: "p", code: "1+`a", error: "type", trace: "" }, history: () => history };
    stub.config.user["errorExplain.enable"] = false;
    const api = registerErrorExplainer(context, live);
    assert.strictEqual(api.registered(), false);
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.explainError)(), undefined);
    assert.match(stub.messages.at(-1)[1], /error explainer is turned off/);
    assert.deepStrictEqual(shown, []);
    stub.config.user["errorExplain.enable"] = true;
    stub.changeConfig("q-lint.errorExplain.enable");
    assert.strictEqual(api.registered(), true);
    assert.match(await stub.commands.get(LANGUAGE_COMMANDS.explainError)(), /'type/);
    assert.match(await stub.commands.get(LANGUAGE_COMMANDS.explainError)("'length"), /'length/);
    assert.strictEqual(shown.length, 2);
    // The Quick Fix, for a problem that names a q error.
    vscode.CodeAction = class {
      constructor(title, kind) {
        this.title = title;
        this.kind = kind;
      }
    };
    const actions = providers[0].provideCodeActions({}, {}, { diagnostics: [{ message: "`s+1` is 'type: no" }, { message: "plain" }] });
    assert.deepStrictEqual(actions.map((a) => a.command.arguments), [["type"]]);
    stub.config.user["errorExplain.enable"] = false;
    stub.changeConfig("q-lint.errorExplain.enable");
    assert.strictEqual(api.registered(), false);
    assert.strictEqual(providers.length, 0);
  } finally {
    restore();
  }
});

test("a baseline is named first in qlinter.toml, its count read, and its paths made relative", async () => {
  assert.strictEqual(tomlWithBaseline(""), 'baseline = "qlinter-baseline.json"\n');
  assert.strictEqual(tomlWithBaseline('profile = "style"\n\n[lint]\nignore = ["QS"]\n'), 'baseline = "qlinter-baseline.json"\nprofile = "style"\n\n[lint]\nignore = ["QS"]\n');
  assert.strictEqual(tomlWithBaseline("# top\nprofile = 1\n"), '# top\nbaseline = "qlinter-baseline.json"\nprofile = 1\n');
  assert.strictEqual(tomlWithBaseline('baseline = "b.json"\n'), undefined);
  assert.deepStrictEqual(writtenCount("qlinter: wrote 12 finding(s) in 3 file(s) to the baseline x"), { findings: 12, files: 3 });
  assert.strictEqual(writtenCount("nothing"), undefined);
  assert.strictEqual(rebased('{"code":"QS001","count":1,"line":"a","path":"/ws/src/a.q"}', "/ws"), '{"code":"QS001","count":1,"line":"a","path":"src/a.q"}');
  // qlinter writes canonical, /-separated paths: a Windows folder, and a
  // folder reached through a symlink, are matched in that form too (#1080).
  const { win32, posix } = require("node:path");
  const row = (p) => `{"code":"QS001","count":1,"line":"a","path":"${p}"}`;
  const win = win32.join("C:\\proj");
  assert.strictEqual(rebased(row("//?/C:/proj/src/a.q"), win), row("src/a.q"));
  assert.strictEqual(rebased(row("C:/proj/src/a.q"), win32.join(win, "\\")), row("src/a.q"));
  assert.strictEqual(rebased(row("c:/proj/src/a.q"), win), row("src/a.q"));
  assert.strictEqual(rebased(row("C:/projx/a.q"), win), row("C:/projx/a.q"));
  assert.strictEqual(rebased(row("/private/tmp/proj/src/a.q"), posix.join("/tmp", "proj"), "/private/tmp/proj"), row("src/a.q"));
  assert.strictEqual(rebased(row("/other/a.q"), "/tmp/proj", "/private/tmp/proj"), row("/other/a.q"));
  // A folder named with a quote or a backslash: its path as JSON escapes it (#1604).
  assert.strictEqual(rebased(row('/ws/my \\"proj\\"/a.q'), '/ws/my "proj"'), row("a.q"));
  assert.strictEqual(absolutePaths(row('../my \\"proj\\"/a\\\\b.q'), "/ws/x"), row('/ws/my \\"proj\\"/a\\\\b.q'));
  assert.strictEqual(rebased(absolutePaths(row('../my \\"proj\\"/a.q'), "/ws/x"), '/ws/my "proj"'), row("a.q"));
  const { context, restore } = setUp();
  try {
    let asked = 0;
    registerBaseline(context, () => (asked++, { command: "qlinter", args: [] }));
    stub.config.user["baseline.enable"] = false;
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.writeBaseline)(), undefined);
    assert.match(stub.messages.at(-1)[1], /lint baseline is turned off/);
    assert.strictEqual(asked, 0);
    // A qlinter that cannot be started is said, the command not failing (#1611).
    stub.config.user["baseline.enable"] = true;
    vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", fsPath: require("node:os").tmpdir() }, name: "tmp" }];
    const missing = require("node:path").join(require("node:os").tmpdir(), "no-such-qlinter-here");
    context.subscriptions.length = 0;
    stub.commands.delete(LANGUAGE_COMMANDS.writeBaseline);
    registerBaseline(context, () => ({ command: missing, args: [] }));
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.writeBaseline)(), undefined);
    assert.match(stub.messages.at(-1)[1], /could not be run/);
    vscode.workspace.workspaceFolders = undefined;
  } finally {
    restore();
  }
});

test("Write Lint Baseline keeps the findings: the draft's ../ paths are resolved before they are made relative (#1275)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  assert.strictEqual(absolutePaths(row1("../../ws/src/a.q"), "/tmp/scratch/x"), row1("/tmp/ws/src/a.q"));
  assert.strictEqual(absolutePaths(row1("/other/a.q"), "/tmp/x"), row1("/other/a.q"));
  assert.strictEqual(absolutePaths(row1("D:/a.q"), "C:/x"), row1("D:/a.q"));
  // qlinter >= #1191 writes each path relative to the baseline's own
  // directory - the scratch one here - through `..`, as this fake does.
  const ws = mkdtempSync(join(tmpdir(), "qlint-bl-ws-"));
  const fake = join(ws, "..", `${require("node:path").basename(ws)}-fake.js`);
  writeFileSync(
    fake,
    `const fs=require("fs"),p=require("path");const a=process.argv;if(!a.includes("--write-baseline"))process.exit(0);const d=a[a.indexOf("--write-baseline")+1];` +
      `const rel=p.relative(fs.realpathSync(p.dirname(d)),p.join(fs.realpathSync(process.cwd()),"src","a.q")).split(p.sep).join("/");` +
      `fs.writeFileSync(d,JSON.stringify({"qlinter-baseline":1,findings:[{code:"QF004",count:1,line:"sum:1",path:rel}]}));` +
      `process.stderr.write("qlinter: wrote 1 finding(s) in 1 file(s)");`,
  );
  mkdirSync(join(ws, "src"));
  const { context, restore } = setUp();
  try {
    vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", fsPath: ws }, name: "ws" }];
    registerBaseline(context, () => ({ command: process.execPath, args: [fake] }));
    stub.picks.push("Write", undefined);
    const target = await stub.commands.get(LANGUAGE_COMMANDS.writeBaseline)();
    assert.strictEqual(target, join(ws, "qlinter-baseline.json"));
    assert.strictEqual(JSON.parse(readFileSync(target, "utf8")).findings[0].path, "src/a.q");
    assert.ok(realpathSync(ws));
  } finally {
    vscode.workspace.workspaceFolders = undefined;
    restore();
    rmSync(ws, { recursive: true, force: true });
    rmSync(fake, { force: true });
  }
});

test("the dead code report refuses when off and asks nothing; on, it lists the server's answer", async () => {
  const answer = { functions: [{ name: "lonely", uri: "file:///ws/b.q", range: { start: { line: 3, character: 0 } } }, { name: ".u.x", uri: "file:///ws/a.q", range: { start: { line: 0, character: 0 } } }], dynamic: 2 };
  const read = readDeadCode(answer);
  assert.deepStrictEqual(read.functions.map((f) => [f.name, f.line]), [["lonely", 3], [".u.x", 0]]);
  assert.strictEqual(readDeadCode(null), undefined);
  const report = deadCodeReport(read.functions, read.dynamic, (u) => u.slice(8), { process: "dev", names: new Set([".u.x"]) });
  assert.match(report, /1 function\(s\) defined in the workspace that nothing in the workspace reads/);
  assert.match(report, /- \[lonely\]\(file:\/\/\/ws\/b\.q#L4\) - line 4/);
  assert.match(report, /## Called on dev/);
  assert.match(report, /in 2 place\(s\)/);
  const { context, shown, restore } = setUp();
  try {
    const sent = [];
    const server = { sendRequest: async (method, params) => (sent.push([method, params]), answer) };
    const calls = [];
    const live = { activeLabel: () => "dev", borrow: (use) => (calls.push(use), undefined) };
    registerDeadCode(context, live, () => server);
    stub.config.user["deadCode.enable"] = false;
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.deadCode)(), undefined);
    assert.deepStrictEqual(sent, []);
    stub.config.user["deadCode.enable"] = true;
    const text = await stub.commands.get(LANGUAGE_COMMANDS.deadCode)();
    assert.deepStrictEqual(sent, [[DEAD_CODE, {}]]);
    assert.match(text, /lonely/);
    assert.strictEqual(shown.length, 1);
    // The process is asked nothing unless checkProcess is on.
    assert.deepStrictEqual(calls, []);
  } finally {
    restore();
  }
});

test("the dead code report's process check failing leaves the report to the workspace (#1370)", async () => {
  const answer = { functions: [{ name: "lonely", uri: "file:///ws/b.q", range: { start: { line: 3, character: 0 } } }], dynamic: 0 };
  const { context, shown, restore } = setUp();
  try {
    const live = { activeLabel: () => "dev", borrow: () => Promise.reject(new Error("'f: closed")) };
    registerDeadCode(context, live, () => ({ sendRequest: async () => answer }));
    stub.config.user["deadCode.enable"] = true;
    stub.config.user["deadCode.checkProcess"] = true;
    stub.messages = [];
    const text = await stub.commands.get(LANGUAGE_COMMANDS.deadCode)();
    assert.match(text, /lonely/);
    assert.strictEqual(shown.length, 1);
    assert.ok(stub.messages.some(([, m]) => /the report is from the workspace alone/.test(m)), JSON.stringify(stub.messages));
  } finally {
    delete stub.config.user["deadCode.checkProcess"];
    restore();
  }
});

test("the dead code report's file names are the decoded paths, relative to the workspace (#1093)", async () => {
  const { fileURLToPath } = require("node:url");
  const answer = {
    functions: [
      { name: "a", uri: "file:///ws/my%20proj/a.q", range: { start: { line: 0, character: 0 } } },
      { name: "b", uri: "file:///c%3A/my%20proj/b.q", range: { start: { line: 0, character: 0 } } },
    ],
    dynamic: 0,
  };
  const { context, restore } = setUp();
  const parse = vscode.Uri.parse;
  // VS Code's Uri.parse decodes; asRelativePath is given a Uri, on either OS.
  vscode.Uri.parse = (s) => ({ fsPath: fileURLToPath(s, { windows: /^file:\/\/\/[a-z]%3A/i.test(s) }) });
  vscode.workspace.asRelativePath = (u) => (typeof u === "string" ? `unparsed ${u}` : u.fsPath.replace(/^\/ws\/|^c:\\/, ""));
  try {
    registerDeadCode(context, { activeLabel: () => undefined }, () => ({ sendRequest: async () => answer }));
    stub.config.user["deadCode.enable"] = true;
    const text = await stub.commands.get(LANGUAGE_COMMANDS.deadCode)();
    // The headings; the links keep the URI. Markdown escapes the backslash.
    const headings = text.split("\n").filter((l) => l.startsWith("## "));
    assert.deepStrictEqual(headings, ["## my proj/a.q", "## my proj\\\\b.q"]);
  } finally {
    vscode.Uri.parse = parse;
    restore();
  }
});

test("the q Namespaces view groups the server's definitions and goes away when off", async () => {
  const answer = [
    { name: ".u.f", namespace: ".u", kind: "function", uri: "file:///a.q", range: { start: { line: 1, character: 0 } } },
    { name: "top", namespace: ".", kind: "variable", uri: "file:///a.q", range: { start: { line: 0, character: 0 } } },
    { name: ".a.g", namespace: ".a", kind: "function", uri: "file:///b.q", range: { start: { line: 2, character: 0 } } },
    { junk: true },
  ];
  const groups = byNamespace(readDefinitions(answer));
  assert.deepStrictEqual(groups.map(([ns, ds]) => [ns, ds.map((d) => d.name)]), [[".", ["top"]], [".a", [".a.g"]], [".u", [".u.f"]]]);
  const { context, restore } = setUp();
  try {
    const sent = [];
    const server = { sendRequest: async (method) => (sent.push(method), answer) };
    stub.config.user["namespaceTree.enable"] = false;
    const api = registerNamespaces(context, () => server);
    assert.strictEqual(api.registered(), false);
    assert.strictEqual(stub.trees.length, 0);
    await stub.commands.get(LANGUAGE_COMMANDS.namespacesRefresh)();
    assert.match(stub.messages.at(-1)[1], /q Namespaces view is turned off/);
    assert.deepStrictEqual(sent, []);
    stub.config.user["namespaceTree.enable"] = true;
    stub.changeConfig("q-lint.namespaceTree.enable");
    assert.strictEqual(api.registered(), true);
    await api.refresh();
    assert.deepStrictEqual(sent.at(-1), DEFINITIONS);
    assert.deepStrictEqual(api.groups().map(([ns]) => ns), [".", ".a", ".u"]);
    stub.config.user["namespaceTree.enable"] = false;
    stub.changeConfig("q-lint.namespaceTree.enable");
    assert.strictEqual(api.registered(), false);
    assert.strictEqual(stub.trees.at(-1).disposed, true);
  } finally {
    restore();
  }
});

test("affected tests on save are off by default; on, a save runs the tests the server names", async () => {
  assert.deepStrictEqual(affectedIds({ tests: [{ uri: "file:///t.q", name: "test_a" }, { uri: "file:///t.q", name: "test_gone" }] }, ["file:///t.q#test_a"]), ["file:///t.q#test_a"]);
  assert.deepStrictEqual(affectedIds(null, ["x"]), []);
  // Two of one name in two namespaces: the one the server names (#1592).
  assert.deepStrictEqual(
    affectedIds({ tests: [{ uri: "file:///t.q", name: "test_x", qualified: ".b.test_x" }] }, ["file:///t.q#.a.test_x", "file:///t.q#.b.test_x"]),
    ["file:///t.q#.b.test_x"],
  );
  const { context, restore } = setUp();
  const saves = [];
  vscode.workspace.onDidSaveTextDocument = (l) => (saves.push(l), { dispose: () => saves.splice(saves.indexOf(l), 1) });
  vscode.workspace.onDidOpenTextDocument = () => ({ dispose() {} });
  vscode.workspace.onDidCloseTextDocument = () => ({ dispose() {} });
  vscode.workspace.textDocuments = [];
  try {
    const sent = [];
    const runs = [];
    const server = { sendRequest: async (method, params) => (sent.push([method, params.previous]), { tests: [{ uri: "file:///t.q", name: "test_a" }] }) };
    const tests = { discover: async () => {}, items: () => ["file:///t.q#test_a"], run: async (ids) => void runs.push(ids) };
    const api = registerAffectedOnSave(context, () => server, tests);
    assert.strictEqual(api.registered(), false);
    assert.strictEqual(saves.length, 0);
    stub.config.user["testing.runAffectedOnSave.enable"] = true;
    stub.changeConfig("q-lint.testing.runAffectedOnSave.enable");
    assert.strictEqual(api.registered(), true);
    const doc = { languageId: "q", uri: { scheme: "file", fsPath: "/w/lib.q", toString: () => "file:///w/lib.q" }, getText: () => "f:{x+1}\n" };
    saves[0](doc);
    await api.settled();
    assert.deepStrictEqual(sent, [[TESTS_REACHING, ""]]);
    assert.deepStrictEqual(runs, [["file:///t.q#test_a"]]);
    stub.config.user["testing.runAffectedOnSave.enable"] = false;
    stub.changeConfig("q-lint.testing.runAffectedOnSave.enable");
    assert.strictEqual(saves.length, 0);
  } finally {
    restore();
  }
});

test("a document already edited when affected tests turn on compares its first save against the file on disk (#1394)", async () => {
  const { context, restore } = setUp();
  const saves = [];
  const fs = vscode.workspace.fs;
  vscode.workspace.onDidSaveTextDocument = (l) => (saves.push(l), { dispose: () => saves.splice(saves.indexOf(l), 1) });
  vscode.workspace.onDidOpenTextDocument = () => ({ dispose() {} });
  vscode.workspace.onDidCloseTextDocument = () => ({ dispose() {} });
  const uri = (p) => ({ scheme: "file", fsPath: p, toString: () => `file://${p}` });
  const dirty = { languageId: "q", uri: uri("/w/lib.q"), isDirty: true, getText: () => "f:{x+2}\n" };
  const clean = { languageId: "q", uri: uri("/w/other.q"), isDirty: false, getText: () => "g:{x}\n" };
  vscode.workspace.textDocuments = [dirty, clean];
  vscode.workspace.fs = { readFile: async (u) => new TextEncoder().encode(u.fsPath === "/w/lib.q" ? "f:{x+1}\n" : "never read") };
  try {
    const sent = [];
    const server = { sendRequest: async (_method, params) => (sent.push([params.textDocument.uri, params.previous]), { tests: [] }) };
    const tests = { discover: async () => {}, items: () => [], run: async () => {} };
    stub.config.user["testing.runAffectedOnSave.enable"] = true;
    const api = registerAffectedOnSave(context, () => server, tests);
    saves[0](dirty);
    saves[0](clean);
    await api.settled();
    assert.deepStrictEqual(sent, [["file:///w/lib.q", "f:{x+1}\n"], ["file:///w/other.q", "g:{x}\n"]]);
    stub.config.user["testing.runAffectedOnSave.enable"] = false;
    stub.changeConfig("q-lint.testing.runAffectedOnSave.enable");
  } finally {
    vscode.workspace.fs = fs;
    restore();
  }
});

test("affected tests queued on save are not run once the setting is turned off (#1086)", async () => {
  const { context, restore } = setUp();
  const saves = [];
  vscode.workspace.onDidSaveTextDocument = (l) => (saves.push(l), { dispose: () => saves.splice(saves.indexOf(l), 1) });
  vscode.workspace.onDidOpenTextDocument = () => ({ dispose() {} });
  vscode.workspace.onDidCloseTextDocument = () => ({ dispose() {} });
  vscode.workspace.textDocuments = [];
  try {
    const sent = [];
    const runs = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const server = { sendRequest: async () => (sent.push(1), await gate, { tests: [{ uri: "file:///t.q", name: "test_a" }] }) };
    const tests = { discover: async () => {}, items: () => ["file:///t.q#test_a"], run: async (ids) => void runs.push(ids) };
    stub.config.user["testing.runAffectedOnSave.enable"] = true;
    const api = registerAffectedOnSave(context, () => server, tests);
    const doc = { languageId: "q", uri: { scheme: "file", fsPath: "/w/lib.q", toString: () => "file:///w/lib.q" }, getText: () => "f:{x+1}\n" };
    saves[0](doc);
    saves[0](doc);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(sent.length, 1);
    // Turned off while the first save's answer is awaited and the second waits.
    stub.config.user["testing.runAffectedOnSave.enable"] = false;
    stub.changeConfig("q-lint.testing.runAffectedOnSave.enable");
    release();
    await api.settled();
    assert.deepStrictEqual(runs, []);
    assert.strictEqual(sent.length, 1, "the queued save asks nothing");
  } finally {
    restore();
  }
});

test("in a workspace that is not trusted a save runs no affected test (#1228)", async () => {
  const { context, restore } = setUp();
  const saves = [];
  const trusted = vscode.workspace.isTrusted;
  vscode.workspace.onDidSaveTextDocument = (l) => (saves.push(l), { dispose: () => saves.splice(saves.indexOf(l), 1) });
  vscode.workspace.onDidOpenTextDocument = () => ({ dispose() {} });
  vscode.workspace.onDidCloseTextDocument = () => ({ dispose() {} });
  vscode.workspace.textDocuments = [];
  try {
    const sent = [];
    const runs = [];
    const server = { sendRequest: async () => (sent.push(1), { tests: [{ uri: "file:///t.q", name: "test_a" }] }) };
    const tests = { discover: async () => {}, items: () => ["file:///t.q#test_a"], run: async (ids) => void runs.push(ids) };
    stub.config.user["testing.runAffectedOnSave.enable"] = true;
    const api = registerAffectedOnSave(context, () => server, tests);
    const doc = { languageId: "q", uri: { scheme: "file", fsPath: "/w/lib.q", toString: () => "file:///w/lib.q" }, getText: () => "f:{x+1}\n" };
    vscode.workspace.isTrusted = false;
    saves[0](doc);
    await api.settled();
    assert.deepStrictEqual([sent, runs], [[], []]);
    // Trusted later: the next save runs them.
    vscode.workspace.isTrusted = true;
    saves[0](doc);
    await api.settled();
    assert.deepStrictEqual(runs, [["file:///t.q#test_a"]]);
  } finally {
    vscode.workspace.isTrusted = trusted;
    restore();
  }
});

test("a save the server does not answer for keeps its baseline: the next save tests its changes too (#1875)", async () => {
  const { context, restore } = setUp();
  const saves = [];
  const trusted = vscode.workspace.isTrusted;
  const said = [];
  vscode.window.setStatusBarMessage = (text) => (said.push(text), { dispose() {} });
  vscode.workspace.onDidSaveTextDocument = (l) => (saves.push(l), { dispose: () => saves.splice(saves.indexOf(l), 1) });
  vscode.workspace.onDidOpenTextDocument = () => ({ dispose() {} });
  vscode.workspace.onDidCloseTextDocument = () => ({ dispose() {} });
  const doc = (text) => ({ languageId: "q", uri: { scheme: "file", fsPath: "/w/a.q", toString: () => "file:///w/a.q" }, isDirty: false, getText: () => text });
  vscode.workspace.textDocuments = [doc("v0")];
  try {
    const sent = [];
    const runs = [];
    let fail = "server restarting";
    let client;
    const server = {
      sendRequest: async (_method, params) => {
        sent.push(params.previous);
        if (fail) throw new Error(fail);
        return { tests: [{ uri: "file:///t.q", name: "test_a" }] };
      },
    };
    let runFails = false;
    const tests = {
      discover: async () => {},
      items: () => ["file:///t.q#test_a"],
      run: async (ids) => {
        if (runFails) throw new Error("no connection");
        runs.push(ids);
      },
    };
    stub.config.user["testing.runAffectedOnSave.enable"] = true;
    const api = registerAffectedOnSave(context, () => client, tests);
    const save = async (text) => {
      saves[0](doc(text));
      await api.settled();
    };
    // No language server yet: nothing is asked, and v0 stays the baseline.
    await save("v1");
    assert.deepStrictEqual([sent, said], [[], []]);
    // The request fails: said, and the baseline still does not move.
    client = server;
    await save("v2");
    assert.deepStrictEqual(sent, ["v0"]);
    assert.strictEqual(said.length, 1);
    assert.match(said[0], /could not find the tests this save affects \(server restarting\)/);
    // Not trusted: nothing is asked.
    fail = "";
    vscode.workspace.isTrusted = false;
    await save("v3");
    assert.deepStrictEqual(sent, ["v0"]);
    vscode.workspace.isTrusted = true;
    // Answered, but the run fails: its tests are still to be run.
    runFails = true;
    await save("v4");
    assert.deepStrictEqual([sent, runs], [["v0", "v0"], []]);
    // Answered and run: every change since v0 was compared, and only now
    // does the next save compare against this one.
    runFails = false;
    await save("v5");
    assert.deepStrictEqual([sent, runs], [["v0", "v0", "v0"], [["file:///t.q#test_a"]]]);
    await save("v6");
    assert.deepStrictEqual(sent, ["v0", "v0", "v0", "v5"]);
    assert.deepStrictEqual(said.slice(1), ["q-lint: running 1 affected test(s)", "q-lint: running 1 affected test(s)", "q-lint: running 1 affected test(s)"]);
    // Two saves queued behind a request that fails: the second is still
    // compared against the text before the first.
    fail = "gone";
    saves[0](doc("v7"));
    saves[0](doc("v8"));
    await api.settled();
    assert.deepStrictEqual(sent.slice(4), ["v6", "v6"]);
    stub.config.user["testing.runAffectedOnSave.enable"] = false;
    stub.changeConfig("q-lint.testing.runAffectedOnSave.enable");
  } finally {
    vscode.workspace.isTrusted = trusted;
    delete vscode.window.setStatusBarMessage;
    restore();
  }
});

test("overlapping reads of the q Namespaces view keep the latest, whichever answers last (#1120)", async () => {
  const def = (name) => ({ name, namespace: ".", kind: "variable", uri: "file:///a.q", range: { start: { line: 0, character: 0 } } });
  const { context, restore } = setUp();
  try {
    const pending = [];
    const server = { sendRequest: () => new Promise((resolve) => pending.push(resolve)) };
    stub.config.user["namespaceTree.enable"] = true;
    const api = registerNamespaces(context, () => server);
    const older = api.refresh();
    const newer = api.refresh();
    // The newer read answers first; the older one, answering after, is stale.
    pending.at(-1)([def("fresh")]);
    await newer;
    pending.at(-2)([def("stale")]);
    await older;
    assert.deepStrictEqual(api.groups()[0][1].map((d) => d.name), ["fresh"]);
  } finally {
    restore();
  }
});

test("SQL is sent to .s.e with its comments dropped, and a write is recognised", () => {
  assert.strictEqual(sqlQuery("select sym, px -- the price\nfrom t\nwhere px > 1;"), '.s.e "select sym, px from t where px > 1"');
  assert.strictEqual(sqlQuery("select 'a--b' as s from t"), `.s.e "select 'a--b' as s from t"`);
  assert.strictEqual(sqlQuery('select "x" from t'), '.s.e "select \\"x\\" from t"');
  // Double quotes hide a comment marker as single ones do, and an apostrophe in them opens nothing (#1099).
  assert.strictEqual(sqlQuery('select "a--b" as x from t'), '.s.e "select \\"a--b\\" as x from t"');
  assert.strictEqual(sqlQuery('select "it\'s" as x -- note\nfrom t'), `.s.e "select \\"it's\\" as x from t"`);
  assert.match(sqlQuery("select 1", true), /^\{if\[not `e in key `\.s;system "l s\.k_"\];\.s\.e x\} "select 1"$/);
  assert.deepStrictEqual(sqlWrites("select * from t"), []);
  assert.deepStrictEqual(sqlWrites("-- note\ninsert into t values (1); DELETE from t"), ["INSERT", "DELETE"]);
  // KDB-X runs a write behind a block comment (checked on KDB-X 5): the
  // write words count wherever they stand outside comments and quotes.
  assert.deepStrictEqual(sqlWrites("/* c */ insert into t values (3)"), ["INSERT"]);
  assert.deepStrictEqual(sqlWrites("/* a\nb */\n  Create table u (a int)"), ["CREATE"]);
  assert.deepStrictEqual(sqlWrites("with x as (select 1) insert into t select * from x"), ["INSERT"]);
  assert.deepStrictEqual(sqlWrites("(update t set a=1)"), ["UPDATE"]);
  assert.deepStrictEqual(sqlWrites("select 'delete' as s, \"drop\" from t -- insert\n/* update */"), []);
  assert.deepStrictEqual(sqlWrites("select 'it''s; delete' from t"), []);
  assert.deepStrictEqual(sqlWrites("select replace(s, 'a', 'b') from t"), []);
  assert.deepStrictEqual(sqlWrites("replace into t values (1)"), ["REPLACE"]);
  // A `--` inside a quote that runs across lines is dropped from what is
  // sent, which moves the quote: the write check judges the sent text (#1408).
  const hidden = "select 'a\n--'\n' as c from t; insert into t values (1) -- '";
  assert.strictEqual(sqlQuery(hidden), `.s.e "${sqlText(hidden)}"`);
  assert.deepStrictEqual(sqlWrites(sqlText(hidden)), ["INSERT"]);
  const schema = readSchema({ trade: ["sym", "px"], quote: ["sym", "bid"] });
  assert.deepStrictEqual([...schema.keys()], ["trade", "quote"]);
  assert.deepStrictEqual(sqlCompletions(schema, "select trade.").map((c) => c.label), ["sym", "px"]);
  assert.deepStrictEqual(sqlCompletions(schema, "select ").map((c) => c.label), ["trade", "sym", "px", "quote", "bid"]);
  assert.strictEqual(readSchema(null).size, 0);
});

test("the SQL tab refuses when off and sends nothing; its completion goes with it", async () => {
  const { context, restore } = setUp();
  const providers = [];
  vscode.languages.registerCompletionItemProvider = (_sel, p) => (providers.push(p), { dispose: () => providers.splice(providers.indexOf(p), 1) });
  try {
    const sent = [];
    const live = { pick: async () => (sent.push("pick"), undefined), queryCode: async (c) => void sent.push(c), activeLabel: () => undefined, fileBinding: () => undefined, processes: () => [] };
    stub.config.user["sql.enable"] = false;
    const api = registerSql(context, live);
    assert.strictEqual(api.registered(), false);
    vscode.window.activeTextEditor = { document: { languageId: "sql", uri: { toString: () => "untitled:1" }, getText: () => "select 1" }, selection: { isEmpty: true } };
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.newSql)(), undefined);
    assert.match(stub.messages.at(-1)[1], /SQL tab for KDB-X is turned off/);
    assert.deepStrictEqual(sent, []);
    stub.config.user["sql.enable"] = true;
    stub.changeConfig("q-lint.sql.enable");
    assert.strictEqual(api.registered(), true);
    // On, with no process connected: the engine is loaded in the query.
    const code = await stub.commands.get(LANGUAGE_COMMANDS.runSql)();
    assert.match(code, /system "l s\.k_"/);
    assert.deepStrictEqual(sent, [code]);
    stub.config.user["sql.enable"] = false;
    stub.changeConfig("q-lint.sql.enable");
    assert.strictEqual(providers.length, 0);
  } finally {
    restore();
  }
});

test("a SQL write on a guarded process is held until confirmed", async () => {
  const { context, restore } = setUp();
  vscode.languages.registerCompletionItemProvider = () => ({ dispose() {} });
  try {
    const sent = [];
    const asked = [];
    const process = { label: "prod1", tags: ["prod"] };
    const live = {
      activeLabel: () => undefined,
      fileBinding: () => "prod1",
      processes: () => [process],
      guardAllows: async (code, targets, what) => (asked.push([code, targets[0].label, what]), false),
      queryCode: async (c) => void sent.push(c),
    };
    registerSql(context, live);
    vscode.window.activeTextEditor = { document: { languageId: "sql", uri: { toString: () => "untitled:2" }, getText: () => "insert into t values (1)" }, selection: { isEmpty: true } };
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.deepStrictEqual(asked, [["`t insert ()", "prod1", "This SQL statement (INSERT)"]]);
    assert.deepStrictEqual(sent, []);
    // A write that only the sent text shows is held too (#1408).
    vscode.window.activeTextEditor.document.getText = () => "select 'a\n--'\n' as c from t; insert into t values (1) -- '";
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.strictEqual(asked.length, 2);
    assert.deepStrictEqual(sent, []);
  } finally {
    restore();
  }
});

test("a SQL write is checked against the process it goes to, and refused while that is unknown", async () => {
  const { context, restore } = setUp();
  vscode.languages.registerCompletionItemProvider = () => ({ dispose() {} });
  try {
    const sent = [];
    const asked = [];
    const prod = { label: "prod1", tags: ["prod"] };
    const dev = { label: "dev1", tags: [] };
    let active;
    const live = {
      activeLabel: () => active,
      fileBinding: () => undefined,
      processes: () => [prod, dev],
      pick: async () => dev,
      guardAllows: async (code, targets, what) => (asked.push([code, targets[0].label, what]), false),
      queryCode: async (c) => void sent.push(c),
    };
    registerSql(context, live);
    // Opened for dev1; its binding gone, the query would go to the active
    // prod1, so prod1 is the one the guard is asked about.
    vscode.window.activeTextEditor = { document: { languageId: "sql", uri: { toString: () => "untitled:3" }, getText: () => "/* c */ insert into t values (1)" }, selection: { isEmpty: true } };
    active = undefined;
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.match(stub.messages.at(-1)[1], /before running SQL that changes data \(INSERT\)/);
    assert.deepStrictEqual(sent, []);
    active = "prod1";
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.deepStrictEqual(asked, [["`t insert ()", "prod1", "This SQL statement (INSERT)"]]);
    assert.deepStrictEqual(sent, []);
  } finally {
    restore();
  }
});

test("a SQL write to a discovered or shared process is guarded, and refused when its process is unknown (#1104)", async () => {
  const { context, restore } = setUp();
  vscode.languages.registerCompletionItemProvider = () => ({ dispose() {} });
  try {
    const sent = [];
    const asked = [];
    const prodHdb = { label: "desk/hdb", tags: ["prod"] };
    let binding;
    let active;
    const live = {
      activeLabel: () => active?.label,
      activeProcess: () => active,
      fileBinding: () => binding,
      processes: () => [],
      discovery: { discovered: () => [] },
      sharedList: () => [{ server: { label: "shared" }, state: { processes: [{ label: "rdb", tags: ["prod"] }] } }],
      guardAllows: async (code, targets, what) => (asked.push([code, targets[0].label, what]), false),
      queryCode: async (c) => void sent.push(c),
    };
    registerSql(context, live);
    vscode.window.activeTextEditor = { document: { languageId: "sql", uri: { toString: () => "untitled:4" }, getText: () => "DELETE FROM trade" }, selection: { isEmpty: true } };
    // Connected to a discovered process: the guard is asked about it.
    active = prodHdb;
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.deepStrictEqual(asked, [["`t insert ()", "desk/hdb", "This SQL statement (DELETE)"]]);
    // Bound to a shared process not connected yet: that one is asked about.
    active = undefined;
    binding = "shared/rdb";
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.deepStrictEqual(asked[1], ["`t insert ()", "shared/rdb", "This SQL statement (DELETE)"]);
    // Bound to a label nothing lists: refused, nothing sent.
    binding = "gone/rdb";
    assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.runSql)(), undefined);
    assert.match(stub.messages.at(-1)[1], /no q process is labelled "gone\/rdb"/);
    assert.strictEqual(asked.length, 2);
    assert.deepStrictEqual(sent, []);
  } finally {
    restore();
  }
});

test("the q the SQL tab shows the guard is one the guard reads as a write", () => {
  const { writes } = require("../out/guard.js");
  assert.ok(writes("`t insert ()").length > 0);
  // And the inline engine load is a system command it asks about.
  assert.ok(writes(sqlQuery("select 1", true)).length > 0);
  assert.deepStrictEqual(writes(sqlQuery("select 1")), []);
});

const QLINTER = require("node:path").resolve(__dirname, "../../../target/release/qlinter");
const noQlinter = require("node:fs").existsSync(QLINTER) ? false : "no qlinter built at target/release";

test("Write Lint Baseline names the baseline in the configuration that governs the folder, not a new qlinter.toml beside it (#1602)", { skip: noQlinter }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  assert.strictEqual(pyprojectWithBaseline('[project]\nname = "x"\n\n[tool.qlinter]\nignore = ["QF004"]\n'), '[project]\nname = "x"\n\n[tool.qlinter]\nbaseline = "qlinter-baseline.json"\nignore = ["QF004"]\n');
  assert.strictEqual(pyprojectWithBaseline('[tool.qlinter]\nbaseline = "b.json"\n'), undefined);
  assert.strictEqual(governingConfiguration("file: /w/*.q\nconfiguration: none - built-in defaults\n"), undefined);
  assert.strictEqual(governingConfiguration("file: /w/*.q\nconfiguration: /w/pyproject.toml\n"), "/w/pyproject.toml");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qlint-bl-gov-")));
  const { context, restore } = setUp();
  try {
    // A pyproject.toml's [tool.qlinter], and a .qlinter.toml in a parent folder.
    const py = join(root, "py");
    mkdirSync(py);
    writeFileSync(join(py, "pyproject.toml"), '[tool.qlinter]\nignore = ["QF004"]\n');
    writeFileSync(join(py, "a.q"), "f:{[count] count}\nsum:1\n");
    const sub = join(root, "parent", "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "parent", ".qlinter.toml"), 'ignore = ["QF004"]\n');
    writeFileSync(join(sub, "a.q"), "f:{[count] count}\nsum:1\n");
    registerBaseline(context, () => ({ command: QLINTER, args: [] }));
    for (const [dir, config, line] of [
      [py, join(py, "pyproject.toml"), 'baseline = "qlinter-baseline.json"'],
      [sub, join(root, "parent", ".qlinter.toml"), 'baseline = "sub/qlinter-baseline.json"'],
    ]) {
      vscode.workspace.workspaceFolders = [{ uri: { scheme: "file", fsPath: dir }, name: "ws" }];
      stub.picks.push("Write", "Add");
      assert.strictEqual(await stub.commands.get(LANGUAGE_COMMANDS.writeBaseline)(), join(dir, "qlinter-baseline.json"));
      assert.strictEqual(existsSync(join(dir, "qlinter.toml")), false, "no qlinter.toml hides the configuration");
      assert.ok(readFileSync(config, "utf8").includes(line), readFileSync(config, "utf8"));
      // The project's ignore still holds, and the baseline hides the rest.
      const out = require("node:child_process").spawnSync(QLINTER, ["--format", "json", "."], { cwd: dir, encoding: "utf8" });
      assert.deepStrictEqual(JSON.parse(out.stdout).length ?? JSON.parse(out.stdout).findings?.length, 0, out.stdout + out.stderr);
    }
  } finally {
    vscode.workspace.workspaceFolders = undefined;
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SQL schema is read only from the process it is kept for, not one connected while it waited (#1457)", async () => {
  const { context, restore } = setUp();
  vscode.languages.registerCompletionItemProvider = () => ({ dispose() {} });
  vscode.workspace.openTextDocument = async () => ({ uri: { toString: () => "untitled:9" } });
  try {
    stub.config.user["sql.enable"] = true;
    let active = "a";
    let busy = true;
    const read = [];
    const live = {
      activeLabel: () => active,
      fileBinding: () => undefined,
      processes: () => [],
      pick: async () => ({ label: "a", tags: [] }),
      borrow: (use) => (busy ? undefined : use({ call: async () => (read.push(active), {}) }, { label: active, tags: [] })),
    };
    registerSql(context, live);
    const opened = stub.commands.get(LANGUAGE_COMMANDS.newSql)();
    await new Promise((r) => setTimeout(r, 20));
    active = "b";
    busy = false;
    assert.deepStrictEqual(await opened, { uri: "untitled:9", label: "a" });
    assert.deepStrictEqual(read, []);
  } finally {
    restore();
  }
});
