// Help pages (#971), runnable examples in hovers (#972) and the cheat sheet
// (#973): the catalogue the pages are made from, what a page and a hover
// show (escaped, their links only to this extension's commands), and each
// feature's life through the stand-in `vscode` - registered while its
// switch is on, refusing and sending nothing when it is off, and a Try it
// on a guarded process held by the read-only guard. The examples against a
// real q are help_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { stub, vscode } = require("./vscode_stub");
const { serialize, deserialize } = require("node-q/lib/c.js");
const h = require("../out/helpcatalog.js");
const pkg = require("../package.json");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const catalog = new h.HelpCatalog(read("help", "builtins.json"), read("help", "examples.json"));

test("the help catalogue is the language server's, byte for byte", () => {
  assert.strictEqual(read("help", "builtins.json"), fs.readFileSync(path.join(root, "..", "..", "src", "builtins.json"), "utf8"), "copy src/builtins.json to editors/vscode/help/builtins.json");
});

test("every example is of a builtin, and every related name is one", () => {
  const examples = JSON.parse(read("help", "examples.json"));
  for (const [name, entry] of Object.entries(examples)) {
    assert.ok(catalog.has(name), name);
    assert.ok(entry.examples.length > 0, name);
    for (const e of entry.examples) {
      assert.ok(typeof e.code === "string" && typeof e.result === "string", name);
    }
    for (const see of entry.see) {
      assert.ok(catalog.has(see), `${name} sees ${see}`);
    }
  }
  assert.ok(Object.keys(examples).length >= 150);
});

test("a page has the syntax, examples, related builtins and the reference page", () => {
  const page = catalog.page("xbar");
  assert.strictEqual(page.syntax, "x xbar y");
  assert.deepStrictEqual(page.related.slice(0, 2), ["div", "bin"]);
  assert.ok(page.examples.length >= 1);
  // The same reference page makes names related: aj and aj0.
  assert.ok(catalog.page("aj").related.includes("aj0"));
  assert.strictEqual(catalog.page("nothing"), undefined);
  const html = h.pageHtml(catalog.page("like"), h.HELP.show, h.HELP.tryExample);
  assert.match(html, /<h1><code>like<\/code>/);
  assert.match(html, /<a class="try" href="command:q-lint\.tryExample\?/);
  assert.match(html, /https:\/\/code\.kx\.com\/q\/ref\/like/);
  // What a page shows is escaped: < and " in an example.
  const odd = h.pageHtml({ name: "<b>", kind: "f", syntax: 'x<"y"', summary: "a&b", examples: [{ code: "1<2", result: "1b" }], related: [] }, h.HELP.show);
  assert.ok(!odd.includes("<b>") && odd.includes("&lt;b&gt;") && odd.includes("x&lt;&quot;y&quot;") && odd.includes("a&amp;b"));
  // No Try it without the command.
  assert.ok(!h.pageHtml(catalog.page("like"), h.HELP.show).includes("Try it"));
});

test("a hover's examples carry Try it with the code as the command's argument", () => {
  const md = h.examplesMarkdown("til", catalog.examples("til"), h.HELP.tryExample, h.HELP.show);
  assert.match(md, /^\*\*Examples of `til`\*\*\n\n```q\ntil 4\n```\ngives `0 1 2 3`/);
  const link = /\[Try it\]\(command:q-lint\.tryExample\?([^ ]+) /.exec(md);
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(link[1])), ["til 4"]);
  assert.match(md, /\[Open the help page\]\(command:q-lint\.showHelp\?/);
  // Backticks in code and result lengthen the fence and span.
  const ticks = h.examplesMarkdown("x", [{ code: "`a`b", result: "`a`b" }]);
  assert.match(ticks, /``` ?q\n`a`b\n```/);
  assert.match(ticks, /gives `` `a`b ``/);
  assert.deepStrictEqual(h.nameAt("x:.Q.s1 y", 4), { name: ".Q.s1", start: 2, end: 7 });
  assert.deepStrictEqual(h.nameAt("a,/:b", 2), { name: "/:", start: 2, end: 4 });
  assert.strictEqual(h.nameAt('"til 3"', 2), undefined);
});

test("the slash that starts a comment is no name, the slash of Over is", () => {
  assert.strictEqual(h.nameAt("a:1 / note", 4), undefined);
  assert.strictEqual(h.nameAt("/ note", 0), undefined);
  assert.deepStrictEqual(h.nameAt("10 2/ 3", 4), { name: "/", start: 4, end: 5 });
});

test("glyphs are cut as q cuts them: an operator, then its iterator", () => {
  const at = (line, c) => h.nameAt(line, c)?.name;
  assert.strictEqual(at("a:-1", 2), "-");
  assert.strictEqual(at("a:-1", 1), ":");
  assert.strictEqual(at("s:+/x", 2), "+");
  assert.strictEqual(at("s:+/x", 3), "/");
  assert.strictEqual(at("r:raze x,/:y", 8), ",");
  assert.strictEqual(at("r:raze x,/:y", 9), "/:");
  assert.strictEqual(at("x<>y", 1), "<>");
  assert.strictEqual(at("x<=y", 2), "<=");
  // 0:, 1: and 2: are one operator each, never Assign (#1750).
  assert.strictEqual(at("x 0:y", 3), "0:");
  assert.strictEqual(at("x 1: y", 3), "1:");
  assert.strictEqual(at("`:f 2:(`f;1)", 5), "2:");
  assert.strictEqual(at("a10:3", 3), ":");
  assert.strictEqual(at("x:10:y", 4), ":");
  assert.strictEqual(at("deltas-':x", 7), "':");
  assert.strictEqual(at("a::1", 1), "::");
  // Every one is in the catalogue.
  for (const [line, c] of [["a:-1", 2], ["s:+/x", 2], ["r:raze x,/:y", 8], ["r:raze x,/:y", 9]]) {
    assert.ok(catalog.has(at(line, c)), line);
  }
  // A cursor just after a word is still on it.
  assert.deepStrictEqual(h.nameAt("til 3", 3), { name: "til", start: 0, end: 3 });
});

test("a symbol is no name: `max is not the builtin", () => {
  assert.strictEqual(h.nameAt("t:`time`max`count xcol t", 8), undefined);
  assert.strictEqual(h.nameAt("x:`last", 4), undefined);
  assert.strictEqual(h.nameAt("(`max;`p)", 3), undefined);
  assert.strictEqual(h.nameAt("`:db/max", 5), undefined);
  assert.strictEqual(h.nameAt("`a:b/count", 6), undefined);
  // The words after it still are.
  assert.strictEqual(h.nameAt("t:`time`max`count xcol t", 19)?.name, "xcol");
  assert.strictEqual(h.nameAt("`a`b!1 2", 4)?.name, "!");
  assert.strictEqual(h.nameAt("`$\"x\"", 1)?.name, "$");
});

test("a line in a block comment, or after the script's end, is commented out", () => {
  const lines = ["a:1", "/", "count the rows here", "  / nested", "\\", "count x", "\\", "count y", "\\  ", "count z"];
  assert.deepStrictEqual(lines.map((_, i) => h.commentedOut(lines.slice(0, i + 1))), [false, true, true, true, true, false, true, true, true, true]);
  // Nested: `/` alone inside one opens another.
  assert.strictEqual(h.commentedOut(["/", "/", "\\", "count x"]), true);
  assert.strictEqual(h.commentedOut(["count x"]), false);
});

test("a word in a string open from the line above is no name, and a / and a no-break space comments out nothing below it (#2910)", () => {
  const { lineContext } = require("../out/statements.js");
  const under = (lines, line, character) => {
    const { commented, quoted } = lineContext(lines.slice(0, line + 1));
    return commented ? undefined : h.nameAt(lines[line], character, quoted)?.name;
  };
  // KDB-X reads the two lines as one string: `from` and `in` are its text.
  const query = ['s:"select count i', '  from trade where sym in syms"', "n:count s", '  ,"in"', "  ,count s"];
  assert.strictEqual(under(query, 1, 3), undefined);
  assert.strictEqual(under(query, 1, 22), undefined);
  assert.strictEqual(under(query, 2, 3), "count");
  // After the string closes the line is code again, and a continuation
  // line's own string is still one.
  assert.strictEqual(under(query, 3, 5), undefined);
  assert.strictEqual(under(query, 4, 4), "count");
  assert.strictEqual(under(['s:"a', '  b",count 1'], 1, 6), "count");
  // A string an unindented line leaves open does not reach the statement
  // below it, and a comment's quote opens none.
  assert.strictEqual(under(['s:"a', "n:count s"], 1, 3), "count");
  assert.strictEqual(under(['a:1 / "', "  +count a"], 1, 4), "count");
  // q's blanks only: `/` and a no-break space or a form feed is a line
  // comment, and the lines under it are run.
  for (const blank of ["\u00a0", "\f"]) {
    assert.strictEqual(h.commentedOut(["a:1", `/${blank}`, "n:count a"]), false);
    assert.strictEqual(under(["a:1", `/${blank}`, "n:count a"], 2, 3), "count");
    assert.strictEqual(h.commentedOut(["a:1", `\\${blank}`, "n:count a"]), false);
  }
});

test("the cheat sheet has its four sections, each item with an example and result", () => {
  const sheet = h.readCheatSheet(read("help", "cheatsheet.json"));
  assert.deepStrictEqual(sheet.map((s) => s.section), ["Iterators", "Joins", "Temporal casts", "Attributes"]);
  for (const item of sheet.flatMap((s) => s.items)) {
    assert.ok(item.insert && item.description && item.example && item.result, item.label);
  }
});

// Eight examples built their tables in the globals t, q and kt, and Try it
// then replaced those on the connected process (#1991). What is assigned is
// what the read-only guard reads as an assignment.
test("no example assigns a global: its tables are written where they are used", () => {
  const { writes } = require("../out/guard.js");
  const examples = JSON.parse(read("help", "examples.json"));
  const sheet = h.readCheatSheet(read("help", "cheatsheet.json"));
  const codes = [
    ...Object.entries(examples).flatMap(([name, entry]) => entry.examples.map((e) => [name, e.code])),
    ...sheet.flatMap((s) => s.items.map((item) => [item.label, item.example])),
  ];
  const assigning = codes.map(([name, code]) => [name, writes(code).filter((r) => r.startsWith("assigns "))]).filter(([, reasons]) => reasons.length > 0);
  // insert takes its table by name alone: its example sets one and deletes it again (#2545).
  assert.deepStrictEqual(assigning, []);
  assert.deepStrictEqual(writes("t:([] a:1 2); `t insert 3; t").filter((r) => r.startsWith("assigns ")), ["assigns t"]);
});

test("the switches are declared, on by default, and hide their commands and view when off", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  for (const key of ["helpPages", "tryExamples", "cheatSheet"]) {
    assert.strictEqual(props[`q-lint.${key}.enable`].default, true, key);
  }
  const when = (command) => pkg.contributes.menus.commandPalette.find((m) => m.command === command).when;
  assert.strictEqual(when(h.HELP.show), "config.q-lint.helpPages.enable");
  assert.strictEqual(when(h.HELP.tryExample), "false");
  assert.strictEqual(when(h.CHEAT_SHEET.show), "config.q-lint.cheatSheet.enable");
  assert.strictEqual(when(h.CHEAT_SHEET.insert), "false");
  const view = pkg.contributes.views["q-lint"].find((v) => v.id === h.CHEAT_SHEET.view);
  assert.strictEqual(view.when, "config.q-lint.cheatSheet.enable");
});

/// Hover and webview APIs that record what is made of them.
function fakeUi() {
  const ui = { hovers: [], panels: [] };
  vscode.languages = {
    registerHoverProvider: (selector, provider) => {
      const entry = { provider, disposed: false, dispose() { this.disposed = true; } };
      ui.hovers.push(entry);
      return entry;
    },
  };
  vscode.Hover = class { constructor(contents, range) { Object.assign(this, { contents, range }); } };
  vscode.Range = class { constructor(a, b, c, d) { Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d } }); } };
  vscode.window.createWebviewPanel = (id, title, column, options) => {
    const panel = {
      id, title, column, options, disposed: false, reveals: [],
      webview: { html: "", cspSource: "vscode-resource:", asWebviewUri: (u) => u },
      reveal(...where) { this.reveals.push(where); },
      onDidDispose(f) { this.disposeListener = f; },
      dispose() { this.disposed = true; this.disposeListener?.(); },
    };
    ui.panels.push(panel);
    return panel;
  };
  return ui;
}

test("Show Help opens a page, Try it runs an example, and each refuses when turned off", async () => {
  stub.reset();
  const ui = fakeUi();
  const ran = [];
  const live = { run: async (code) => void ran.push(code) };
  const { registerHelp } = require("../out/helpview.js");
  const context = { ...stub.newContext(), extensionPath: root };
  const api = registerHelp(context, live);
  assert.strictEqual(api.hoverRegistered(), true);
  assert.strictEqual(await stub.commands.get(h.HELP.show)("xbar"), "xbar");
  const panel = ui.panels[0];
  assert.strictEqual(panel.title, "q Help: xbar");
  assert.deepStrictEqual(panel.options.enableCommandUris, [h.HELP.show, h.HELP.tryExample]);
  assert.strictEqual(panel.options.enableScripts, false);
  assert.match(panel.webview.html, /Content-Security-Policy" content="default-src 'none'; style-src vscode-resource:;"/);
  assert.match(api.shown().html, /Try it/);
  // A related name opens in the same panel.
  await stub.commands.get(h.HELP.show)("bin");
  assert.strictEqual(ui.panels.length, 1);
  assert.strictEqual(panel.title, "q Help: bin");
  // Opened beside the editor, and shown again where it is: "beside" on a
  // reveal is beside the page itself when a link in it was clicked (#1919).
  assert.deepStrictEqual(panel.column, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
  assert.notStrictEqual(vscode.ViewColumn.Beside, undefined);
  assert.deepStrictEqual(panel.reveals, [[undefined, true], [undefined, true]]);
  // From the word under the cursor; a word q does not define is picked from the list.
  vscode.window.activeTextEditor = { document: { lineAt: () => ({ text: "x:til 3" }) }, selection: { active: { line: 0, character: 3 } } };
  assert.strictEqual(await stub.commands.get(h.HELP.show)(), "til");
  vscode.window.activeTextEditor = { document: { lineAt: () => ({ text: "myfun 3" }) }, selection: { active: { line: 0, character: 2 } } };
  stub.picks.push((options) => options.items.find((i) => i.label === "sum"));
  assert.strictEqual(await stub.commands.get(h.HELP.show)(), "sum");
  assert.strictEqual(await stub.commands.get(h.HELP.show)("nope"), undefined);
  // The hover: examples with Try it, trusted for this extension's two commands only.
  const hover = ui.hovers[0].provider.provideHover({ lineAt: () => ({ text: "til 4" }) }, { line: 0, character: 1 });
  assert.match(hover.contents.value, /\[Try it\]\(command:q-lint\.tryExample/);
  assert.deepStrictEqual(hover.contents.isTrusted, { enabledCommands: [h.HELP.tryExample, h.HELP.show] });
  assert.strictEqual(ui.hovers[0].provider.provideHover({ lineAt: () => ({ text: "myfun" }) }, { line: 0, character: 1 }), undefined);
  // Nothing in a block comment, which only the lines above tell.
  const block = ["/", "count the rows here", "\\", "count x"];
  const doc = { lineAt: (i) => ({ text: block[i] }) };
  assert.strictEqual(ui.hovers[0].provider.provideHover(doc, { line: 1, character: 2 }), undefined);
  assert.ok(ui.hovers[0].provider.provideHover(doc, { line: 3, character: 2 }));
  // Nor in a string open from the line above (#2910).
  const text = ['s:"select count i', '  from trade where sym in syms"', "count s"];
  const strung = { lineAt: (i) => ({ text: text[i] }) };
  assert.strictEqual(ui.hovers[0].provider.provideHover(strung, { line: 1, character: 22 }), undefined);
  assert.ok(ui.hovers[0].provider.provideHover(strung, { line: 2, character: 2 }));
  assert.strictEqual(await stub.commands.get(h.HELP.tryExample)("til 4"), true);
  assert.deepStrictEqual(ran, ["til 4"]);
  // Try examples off: no hover, Try it refuses and sends nothing, the open page loses its links.
  stub.config.user["tryExamples.enable"] = false;
  stub.changeConfig("q-lint.tryExamples.enable");
  assert.strictEqual(ui.hovers[0].disposed, true);
  assert.strictEqual(api.hoverRegistered(), false);
  assert.strictEqual(await stub.commands.get(h.HELP.tryExample)("til 4"), false);
  assert.deepStrictEqual(ran, ["til 4"]);
  assert.match(stub.messages.at(-1)[1], /Runnable examples in hovers is turned off\. Set q-lint\.tryExamples\.enable to true/);
  assert.ok(!api.shown().html.includes("Try it"));
  // Help pages off: the page closes, Show Help refuses.
  stub.config.user["helpPages.enable"] = false;
  stub.changeConfig("q-lint.helpPages.enable");
  assert.strictEqual(panel.disposed, true);
  assert.strictEqual(await stub.commands.get(h.HELP.show)("til"), undefined);
  assert.strictEqual(ui.panels.length, 1);
  assert.match(stub.messages.at(-1)[1], /help pages for q's builtins is turned off\. Set q-lint\.helpPages\.enable to true/);
  // Both on again, without a reload.
  stub.config.user["tryExamples.enable"] = true;
  stub.config.user["helpPages.enable"] = true;
  stub.changeConfig("q-lint.tryExamples.enable");
  assert.strictEqual(api.hoverRegistered(), true);
  for (const d of context.subscriptions) d.dispose?.();
  vscode.window.activeTextEditor = undefined;
});

/// A q process played by a socket server, every message kept decoded.
async function fakeQ() {
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        sent.push(deserialize(message));
        const out = serialize({ ok: true, type: -7, text: ["1"] });
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, sent, close: () => (sockets.forEach((s) => s.destroy()), server.close()) };
}

test("Try it on a guarded process asks first, and a write declined sends nothing", async (t) => {
  stub.reset();
  fakeUi();
  const q = await fakeQ();
  const { Live } = require("../out/live.js");
  const { registerHelp } = require("../out/helpview.js");
  const context = { ...stub.newContext(), extensionPath: root };
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags: ["prod"] }]);
  const live = new Live(context);
  registerHelp(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  assert.strictEqual(await live.connectTo("rdb"), true);
  const before = q.sent.length;
  const insert = catalog.examples("insert")[0].code;
  stub.picks.push(undefined);
  await stub.commands.get(h.HELP.tryExample)(insert);
  assert.deepStrictEqual(stub.messages.filter(([k, m]) => k === "warning" && /would change/.test(m)).map(([, m]) => m), ["This code would change rdb. Run it anyway?"]);
  assert.strictEqual(q.sent.length, before);
  // An example that only reads goes unasked.
  await stub.commands.get(h.HELP.tryExample)("til 4");
  assert.strictEqual(q.sent.length, before + 1);
  assert.deepStrictEqual(q.sent.at(-1)[1], ["til 4"]);
});

test("the cheat sheet view lives while its switch is on, and inserts at the cursor", async () => {
  stub.reset();
  const { registerCheatSheet } = require("../out/cheatsheetview.js");
  const context = { ...stub.newContext(), extensionPath: root };
  const api = registerCheatSheet(context);
  const tree = stub.trees.find((v) => v.id === h.CHEAT_SHEET.view);
  assert.ok(tree && api.view() === tree);
  const provider = tree.options.treeDataProvider;
  const sections = provider.getChildren();
  assert.strictEqual(sections.length, 4);
  const each = provider.getChildren(sections[0])[0];
  const item = provider.getTreeItem(each);
  assert.strictEqual(item.label, "each");
  assert.strictEqual(item.description, "f each x");
  assert.deepStrictEqual(item.command, { command: h.CHEAT_SHEET.insert, title: "Insert", arguments: [each] });
  const editor = { text: "r:", selections: [{ s: 2, e: 2 }], edit: async (f) => (f({ replace: (s, x) => (editor.text = editor.text.slice(0, s.s) + x + editor.text.slice(s.e)) }), true) };
  vscode.window.activeTextEditor = editor;
  assert.strictEqual(await stub.commands.get(h.CHEAT_SHEET.insert)(each), "f each x");
  assert.strictEqual(editor.text, "r:f each x");
  assert.strictEqual(await stub.commands.get(h.CHEAT_SHEET.insert)("lj, left join"), "t lj kt");
  // Off: the tree goes, inserting refuses.
  stub.config.user["cheatSheet.enable"] = false;
  stub.changeConfig("q-lint.cheatSheet.enable");
  assert.strictEqual(tree.disposed, true);
  assert.strictEqual(api.view(), undefined);
  editor.text = "";
  assert.strictEqual(await stub.commands.get(h.CHEAT_SHEET.insert)(each), undefined);
  assert.strictEqual(editor.text, "");
  assert.match(stub.messages.at(-1)[1], /q cheat sheet is turned off\. Set q-lint\.cheatSheet\.enable to true/);
  stub.config.user["cheatSheet.enable"] = true;
  stub.changeConfig("q-lint.cheatSheet.enable");
  assert.ok(api.view() !== undefined && api.view() !== tree);
  for (const d of context.subscriptions) d.dispose?.();
  vscode.window.activeTextEditor = undefined;
});

// The dot, colon or minus inside a literal was taken for Apply, Assign or
// Subtract (#2410).
test("a number or temporal literal is no glyph: its dot, colon and minus are not looked up (#2410)", () => {
  for (const [line, at] of [["d:2024.01.01", 6], ["x:1.5", 3], ["t:12:30", 4], ["x:1e-3", 4], ["t:2024.01.02D10:00:00", 13], ["x:.5", 2]]) {
    assert.strictEqual(h.nameAt(line, at), undefined, `${line} at ${at}`);
  }
  // The operators around one still are, and 0: 1: 2: are one operator each.
  assert.deepStrictEqual(h.nameAt("a:-1", 2), { name: "-", start: 2, end: 3 });
  assert.deepStrictEqual(h.nameAt("x:1.5", 1), { name: ":", start: 1, end: 2 });
  assert.deepStrictEqual(h.nameAt("`:f 0: x", 4), { name: "0:", start: 4, end: 6 });
  assert.deepStrictEqual(h.nameAt("x . y", 2), { name: ".", start: 2, end: 3 });
  assert.deepStrictEqual(h.nameAt("10 2/ 3", 4), { name: "/", start: 4, end: 5 });
});
