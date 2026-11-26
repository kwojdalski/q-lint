// The page of the Interactive Window and the q REPL pane (media/console.js)
// over a small stand-in DOM: runs are drawn as text, never HTML, and the
// REPL's keys ask the extension (Enter, Tab, Ctrl+R) or walk the history.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "media", "console.js"), "utf8");

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this._text = "";
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  addEventListener(type, f) { (this.listeners[type] ??= []).push(f); }
  setAttribute(k, v) { this.attributes[k] = v; }
  focus() {}
  scrollIntoView() {}
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  get innerHTML() { throw new Error("the page must not read or write HTML"); }
  set innerHTML(_v) { throw new Error("the page must not read or write HTML"); }
}

function load(input) {
  const body = new El("body");
  body.dataset.input = input ? "yes" : "no";
  const posted = [];
  const listeners = [];
  const window = { addEventListener: (type, f) => type === "message" && listeners.push(f) };
  vm.runInNewContext(SOURCE, {
    // Posted from another realm: copied, so they compare as plain objects.
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }),
    document: { body, createElement: (tag) => new El(tag) },
    window,
  });
  const send = (data) => listeners.forEach((f) => f({ data }));
  const find = (tag, el = body) => (el.tag === tag ? [el] : []).concat(...el.children.map((c) => find(tag, c)));
  const key = (k, extra = {}) => {
    let prevented = false;
    const event = { key: k, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => (prevented = true), ...extra };
    find("textarea")[0].listeners.keydown.forEach((f) => f(event));
    return prevented;
  };
  return { body, posted, send, find, key };
}

test("the Interactive Window draws each run as text: name, process, code and answer", () => {
  const page = load(false);
  assert.deepStrictEqual(page.posted, [{ type: "ready" }]);
  assert.strictEqual(page.find("textarea").length, 0, "no input box");
  page.send({ type: "all", entries: [{ id: 1, title: "<b>load</b>", code: "a:1\nb:2", process: "dev", millis: 3, ok: true, lines: ["<script>x</script>"] }] });
  const text = page.find("main")[0].textContent;
  assert.match(text, /<b>load<\/b>dev - 3 ms/);
  assert.match(text, /q\)a:1\n  b:2/);
  assert.match(text, /<script>x<\/script>/);
  page.send({ type: "add", entry: { id: 2, code: "boom", lines: [] } });
  assert.match(page.find("main")[0].textContent, /running\.\.\./);
  page.send({ type: "update", entry: { id: 2, code: "boom", ok: false, lines: ["'boom"] } });
  assert.strictEqual(page.find("pre").filter((p) => p.className === "error")[0].textContent, "'boom");
  page.send({ type: "remove", id: 2 });
  assert.strictEqual(page.find("section").length, 1);
  page.find("button")[0].listeners.click[0]();
  assert.deepStrictEqual(page.posted.at(-1), { type: "clear" });
  page.send({ type: "clear" });
  assert.strictEqual(page.find("section").length, 0);
});

test("the REPL's keys: Enter and Tab ask the extension, Up and Down walk the history", () => {
  const page = load(true);
  const input = page.find("textarea")[0];
  page.send({ type: "all", entries: [], history: ["newest", "older"] });
  input.value = "1+1";
  input.selectionStart = input.selectionEnd = 3;
  assert.ok(page.key("Enter"));
  assert.deepStrictEqual(page.posted.at(-1), { type: "enter", code: "1+1" });
  assert.ok(!page.key("Enter", { shiftKey: true }), "Shift+Enter is left to the textarea: a new line");
  // The extension says the input is not complete: a new line goes in.
  input.value = "f:{";
  input.selectionStart = input.selectionEnd = 3;
  page.send({ type: "newline" });
  assert.strictEqual(input.value, "f:{\n");
  // Accepted: cleared, and the history given.
  page.send({ type: "accepted", history: ["f:{\n}", "newest", "older"] });
  assert.strictEqual(input.value, "");
  // #2498: typed after Enter, before the answer: kept.
  input.value = "y:2";
  page.send({ type: "accepted", history: ["x:1", "f:{\n}", "newest", "older"], code: "x:1" });
  assert.strictEqual(input.value, "y:2");
  input.value = "x:1";
  page.send({ type: "accepted", history: ["x:1", "f:{\n}", "newest", "older"], code: "x:1" });
  assert.strictEqual(input.value, "");
  page.send({ type: "accepted", history: ["f:{\n}", "newest", "older"] });
  assert.ok(page.key("ArrowUp"));
  assert.strictEqual(input.value, "f:{\n}");
  input.selectionStart = input.selectionEnd = 0;
  page.key("ArrowUp");
  assert.strictEqual(input.value, "newest");
  page.key("ArrowDown");
  page.key("ArrowDown");
  assert.strictEqual(input.value, "", "back to the draft");
  // Tab asks; one answer goes straight in, several are listed.
  input.value = "x:cou";
  input.selectionStart = input.selectionEnd = 5;
  assert.ok(page.key("Tab"));
  assert.deepStrictEqual(page.posted.at(-1), { type: "complete", text: "x:cou", caret: 5 });
  page.send({ type: "completions", start: 2, caret: 5, items: [{ label: "count", detail: "q" }] });
  assert.strictEqual(input.value, "x:count");
  input.value = "x:co";
  input.selectionStart = input.selectionEnd = 4;
  page.key("Tab");
  page.send({ type: "completions", start: 2, caret: 4, items: [{ label: "cos", detail: "q" }, { label: "cols", detail: "q" }] });
  const list = page.find("ul")[0];
  assert.strictEqual(list.hidden, false);
  page.key("ArrowDown");
  page.key("Enter");
  assert.strictEqual(input.value, "x:cols");
  assert.strictEqual(list.hidden, true);
});

test("a run from the editor is added to the history and leaves what is typed in the input (#1922)", () => {
  const page = load(true);
  const input = page.find("textarea")[0];
  page.send({ type: "all", entries: [], history: ["newest", "older"] });
  input.value = "r:select from trade where\n  sym=`AAPL,";
  input.selectionStart = input.selectionEnd = input.value.length;
  page.send({ type: "history", history: ["til 3", "newest", "older"] });
  assert.strictEqual(input.value, "r:select from trade where\n  sym=`AAPL,");
  // Up from its first line walks the history given, and Down comes back to it.
  input.selectionStart = input.selectionEnd = 0;
  page.key("ArrowUp");
  assert.strictEqual(input.value, "til 3");
  input.selectionStart = input.selectionEnd = 0;
  page.key("ArrowUp");
  assert.strictEqual(input.value, "newest");
  // While walking: the place kept is the entry on show, wherever it now is.
  page.send({ type: "history", history: ["1+1", "til 3", "newest", "older"] });
  assert.strictEqual(input.value, "newest");
  input.selectionStart = input.selectionEnd = 0;
  page.key("ArrowUp");
  assert.strictEqual(input.value, "older");
  page.key("ArrowDown");
  page.key("ArrowDown");
  page.key("ArrowDown");
  page.key("ArrowDown");
  assert.strictEqual(input.value, "r:select from trade where\n  sym=`AAPL,", "back to the draft");
  // The Interactive Window has no input to keep.
  load(false).send({ type: "history", history: ["x"] });
});

test("a key pressed while an input method composes is the input method's: its Enter runs nothing (#1923)", () => {
  const page = load(true);
  const input = page.find("textarea")[0];
  page.send({ type: "all", entries: [], history: ["newest", "older"] });
  input.value = 'msg:"にほん';
  input.selectionStart = input.selectionEnd = input.value.length;
  const sent = page.posted.length;
  // The Enter that takes a candidate, as Chromium sends it, and as Safari does.
  assert.ok(!page.key("Enter", { isComposing: true, keyCode: 229 }));
  assert.ok(!page.key("Enter", { isComposing: false, keyCode: 229 }));
  assert.ok(!page.key("Enter", { isComposing: true, keyCode: 13 }));
  // Nor do Tab and the arrows, which move through the candidates.
  assert.ok(!page.key("Tab", { isComposing: true, keyCode: 229 }));
  assert.ok(!page.key("ArrowUp", { isComposing: true, keyCode: 229 }));
  assert.strictEqual(page.posted.length, sent);
  assert.strictEqual(input.value, 'msg:"にほん');
  // In a history search too: the search stays open and nothing runs.
  page.key("r", { ctrlKey: true });
  assert.ok(!page.key("Enter", { isComposing: true, keyCode: 229 }));
  assert.ok(!page.key("Process", { isComposing: true, keyCode: 229 }));
  assert.strictEqual(page.posted.length, sent);
  assert.match(page.find("div").find((d) => d.className === "search").textContent, /^reverse search: $/);
  page.key("Escape");
  // Composed, Enter runs the line.
  input.value = 'msg:"にほん"';
  assert.ok(page.key("Enter", { isComposing: false, keyCode: 13 }));
  assert.deepStrictEqual(page.posted.at(-1), { type: "enter", code: 'msg:"にほん"' });
});

test("completions that arrive after the input ran or changed are dropped (#1337)", () => {
  const page = load(true);
  const input = page.find("textarea")[0];
  const one = { type: "completions", start: 0, caret: 3, items: [{ label: "count", detail: "q" }] };
  const tab = (text) => {
    input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    page.key("Tab");
  };
  // Enter before the answer: the line ran and the box was cleared.
  tab("cou");
  page.key("Enter");
  page.send({ type: "accepted", history: ["cou"] });
  assert.strictEqual(input.value, "");
  page.send(one);
  assert.strictEqual(input.value, "", "nothing is typed into the cleared box");
  // Typed on before the answer: its places are no longer this text's.
  tab("cou");
  input.value = "cou+1";
  input.selectionStart = input.selectionEnd = 5;
  page.send(one);
  assert.strictEqual(input.value, "cou+1");
  page.send({ ...one, items: [...one.items, { label: "cousin", detail: "dev" }] });
  assert.strictEqual(page.find("ul")[0].hidden, true, "no list for an answer nobody is waiting for");
  // An answer for the text as it stands still goes in.
  tab("cou");
  page.send(one);
  assert.strictEqual(input.value, "count");
});

test("Ctrl+R searches the history through the extension, and a key other than typing keeps what it found", () => {
  const page = load(true);
  const input = page.find("textarea")[0];
  assert.ok(page.key("r", { ctrlKey: true }));
  page.key("s");
  assert.deepStrictEqual(page.posted.at(-1), { type: "search", query: "s", from: 0 });
  page.send({ type: "found", index: 2, code: "select from t" });
  assert.strictEqual(input.value, "select from t");
  page.key("r", { ctrlKey: true });
  assert.deepStrictEqual(page.posted.at(-1), { type: "search", query: "s", from: 3 });
  page.send({ type: "found", index: -1, code: "" });
  assert.match(page.find("div").find((d) => d.className === "search").textContent, /reverse search: s \(no match\)/);
  page.key("Enter");
  assert.deepStrictEqual(page.posted.at(-1), { type: "enter", code: "select from t" });
});

test("a finished run is announced in a polite live region, its lines and time or its error; off, there is none (#1188)", () => {
  const page = load(true);
  const region = () => page.find("div").find((d) => d.attributes["aria-live"] === "polite");
  page.send({ type: "all", entries: [] });
  assert.strictEqual(region(), undefined, "off unless the extension says on");
  page.send({ type: "all", entries: [], announce: true });
  assert.strictEqual(region().attributes.role, "status");
  page.send({ type: "add", entry: { id: 1, code: "til 3", process: "dev", lines: [] } });
  assert.strictEqual(region().textContent, "", "nothing while it runs");
  page.send({ type: "update", entry: { id: 1, code: "til 3", process: "dev", millis: 4, ok: true, lines: ["0 1 2"] } });
  assert.strictEqual(region().textContent, "1 line in 4 ms");
  page.send({ type: "update", entry: { id: 2, code: "boom", millis: 1, ok: false, lines: ["", "'boom"] } });
  assert.strictEqual(region().textContent, "Error in 1 ms: 'boom");
  // Turned off without a reload: the region goes.
  page.send({ type: "announce", on: false });
  assert.strictEqual(region(), undefined);
  page.send({ type: "update", entry: { id: 3, code: "1", ok: true, lines: ["1"] } });
  assert.strictEqual(region(), undefined);
  page.send({ type: "announce", on: true });
  page.send({ type: "update", entry: { id: 3, code: "1", ok: true, lines: ["1", "2"] } });
  assert.strictEqual(region().textContent, "2 lines");
});
