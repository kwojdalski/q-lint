// The q Plots view (#970): the plots kept, one per result and kind, newest
// last; what is refused as a plot; and the view's life through the
// stand-in `vscode` - registered while q-lint.results.plots.enable is on,
// stepping through and saving the plot on show, and, off, unregistered,
// its plots dropped and its commands refusing. The result panel's side is
// in resultpanel.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { PlotStore, PLOTS, PLOT_COMMANDS, plainSvg, plotFileName } = require("../out/plots.js");
const pkg = require("../package.json");

const svg = (label) => `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><text>${label}</text></svg>`;
const plot = (key, label, at = 0) => ({ key, process: "dev", code: "select from t", kind: key.split("/")[1], svg: svg(label), at });

test("plots are kept one per result and kind, newest last, the oldest dropped past the limit", () => {
  const store = new PlotStore(3);
  let fired = 0;
  store.onChange(() => fired++);
  store.add(plot("r1/line", "a", 1));
  store.add(plot("r1/bar", "b", 2));
  store.add(plot("r1/line", "c", 3));
  assert.deepStrictEqual(store.list().map((p) => [p.key, p.svg.includes(">c<") ? "c" : p.svg.includes(">b<") ? "b" : "a", p.at]), [["r1/line", "c", 1], ["r1/bar", "b", 2]]);
  assert.strictEqual(store.shown().key, "r1/line");
  store.add(plot("r2/line", "d"));
  store.add(plot("r3/line", "e"));
  assert.deepStrictEqual(store.list().map((p) => p.key), ["r1/bar", "r2/line", "r3/line"]);
  assert.strictEqual(store.current, 2);
  assert.strictEqual(store.move(-5).key, "r1/bar");
  assert.strictEqual(store.move(1).key, "r2/line");
  store.removeShown();
  assert.deepStrictEqual(store.list().map((p) => p.key), ["r1/bar", "r3/line"]);
  assert.strictEqual(store.shown().key, "r3/line");
  store.clear();
  assert.deepStrictEqual([store.list().length, store.current, store.shown()], [0, -1, undefined]);
  assert.strictEqual(store.move(1), undefined);
  assert.ok(fired >= 8);
  assert.strictEqual(plotFileName(plot("r/line", "x", Date.UTC(2024, 0, 2, 3, 4, 5)), "png"), "q-plot-line-20240102T030405.png");
});

test("only chartSvg's plain SVG is kept: no script, handler or link", () => {
  assert.strictEqual(plainSvg(svg("a")), true);
  for (const bad of [42, "<svg><text/></svg>", svg("<script>1</script>"), svg('<a href="x">'), '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>', svg("<foreignObject/>")]) {
    assert.strictEqual(plainSvg(bad), false, String(bad));
  }
});

test("the switch is declared, on by default, and the view and commands are hidden when off", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.results.plots.enable"].default, true);
  const view = pkg.contributes.views["q-lint-results"].find((v) => v.id === PLOT_COMMANDS.view);
  assert.strictEqual(view.when, "config.q-lint.results.plots.enable");
  for (const id of Object.values(PLOT_COMMANDS).filter((id) => id !== PLOT_COMMANDS.view)) {
    assert.strictEqual(pkg.contributes.menus.commandPalette.find((m) => m.command === id).when, "config.q-lint.results.plots.enable", id);
  }
});

test("the view shows the plot on show, steps and saves it, and off is unregistered with its plots dropped", async () => {
  stub.reset();
  const providers = [];
  vscode.window.registerWebviewViewProvider = (id, provider) => {
    const entry = { id, provider, disposed: false, dispose() { this.disposed = true; } };
    providers.push(entry);
    return entry;
  };
  const written = {};
  vscode.workspace.fs = { writeFile: async (uri, bytes) => void (written[uri.fsPath] = Buffer.from(bytes)) };
  const { PlotsView } = require("../out/plotsview.js");
  const context = stub.newContext();
  const view = new PlotsView(context);
  assert.strictEqual(view.registered(), true);
  assert.strictEqual(providers[0].id, PLOT_COMMANDS.view);
  // A page: what it is sent, and what it says.
  const posted = [];
  let receive;
  const page = {
    webview: { options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (u) => u, postMessage: async (m) => void posted.push(m), onDidReceiveMessage: (f) => (receive = f) },
    onDidDispose: () => {},
  };
  providers[0].provider.resolveWebviewView(page);
  assert.match(page.webview.html, /default-src 'none'; style-src vscode-resource:; script-src 'nonce-[^']+'; img-src data:;/);
  receive({ type: "ready" });
  assert.deepStrictEqual(posted.at(-1), { type: "plots", count: 0, index: -1, plot: undefined });
  assert.strictEqual(await stub.commands.get(PLOT_COMMANDS.save)("svg", vscode.Uri.file("/p.svg")), undefined);
  assert.match(stub.messages.at(-1)[1], /no plot to save/);
  PLOTS.add(plot("r1/line", "a"));
  PLOTS.add(plot("r2/bar", "b"));
  assert.deepStrictEqual([posted.at(-1).count, posted.at(-1).index, posted.at(-1).plot.kind], [2, 1, "bar"]);
  assert.strictEqual(await stub.commands.get(PLOT_COMMANDS.previous)(), true);
  assert.strictEqual(posted.at(-1).plot.kind, "line");
  receive({ type: "move", by: 1 });
  assert.strictEqual(posted.at(-1).plot.kind, "bar");
  // SVG is written as kept; a PNG is the page's drawing of it.
  assert.strictEqual(await stub.commands.get(PLOT_COMMANDS.save)("svg", vscode.Uri.file("/p.svg")), "/p.svg");
  assert.strictEqual(written["/p.svg"].toString(), svg("b"));
  const saving = stub.commands.get(PLOT_COMMANDS.save)("png", vscode.Uri.file("/p.png"));
  await new Promise((r) => setImmediate(r));
  const asked = posted.at(-1);
  assert.strictEqual(asked.type, "png");
  receive({ type: "png", key: asked.key, data: "data:image/png;base64,iVBORw0KGgo=" });
  assert.strictEqual(await saving, "/p.png");
  assert.deepStrictEqual([...written["/p.png"].subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  // Two PNGs asked for at once are each saved to their own file (#1092).
  const one = stub.commands.get(PLOT_COMMANDS.save)("png", vscode.Uri.file("/1.png"));
  await new Promise((r) => setImmediate(r));
  const oneKey = posted.at(-1).key;
  const two = stub.commands.get(PLOT_COMMANDS.save)("png", vscode.Uri.file("/2.png"));
  await new Promise((r) => setImmediate(r));
  const twoKey = posted.at(-1).key;
  receive({ type: "png", key: twoKey, data: "data:image/png;base64,iVBORw0KGgo=" });
  receive({ type: "png", key: oneKey, data: "data:image/png;base64,iVBORw0KGgo=" });
  assert.deepStrictEqual(await Promise.all([one, two]), ["/1.png", "/2.png"]);
  receive({ type: "remove" });
  assert.strictEqual(PLOTS.list().length, 1);
  // Off: unregistered, the plots dropped, the commands refuse.
  stub.config.user["results.plots.enable"] = false;
  stub.changeConfig("q-lint.results.plots.enable");
  assert.strictEqual(providers[0].disposed, true);
  assert.strictEqual(view.registered(), false);
  assert.strictEqual(PLOTS.list().length, 0);
  assert.strictEqual(await stub.commands.get(PLOT_COMMANDS.next)(), false);
  assert.match(stub.messages.at(-1)[1], /q Plots view is turned off\. Set q-lint\.results\.plots\.enable to true/);
  stub.config.user["results.plots.enable"] = true;
  stub.changeConfig("q-lint.results.plots.enable");
  assert.strictEqual(view.registered(), true);
  for (const d of context.subscriptions) d.dispose?.();
});
