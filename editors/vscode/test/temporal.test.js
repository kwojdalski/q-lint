// Temporal hover and conversion (#969): literals read and written, the
// conversions of each type, what a hover finds on a line, and the feature's
// life in the editor - the hover registered only while
// q-lint.temporalHover.enable is on, Convert Temporal Value replacing a
// selection and refusing when the feature is off. The values against a real
// q are temporal_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const t = require("../out/temporal.js");
const pkg = require("../package.json");

const texts = (s) => t.convertText(s).conversions.map((c) => c.text);

test("each literal reads to the integer q holds, and is written back as q writes it", () => {
  const cases = [
    ["2024.01.02D03:04:05.123456789", "timestamp", 757479845123456789n],
    ["2000.01.01D00:00:00.000000000", "timestamp", 0n],
    ["1999.12.31D23:59:59.999999999", "timestamp", -1n],
    ["2024.01.02", "date", 8767n],
    ["1999.12.31", "date", -1n],
    ["2024.01m", "month", 288n],
    ["1999.12m", "month", -1n],
    ["2024.01.02T03:04:05.123", "datetime", 8767n * 86400000n + 11045123n],
    ["0D09:30:00.000000000", "timespan", 34200000000000n],
    ["-0D00:00:01.000000000", "timespan", -1000000000n],
    ["09:30:01.500", "time", 34201500n],
    ["-00:00:01.000", "time", -1000n],
    ["09:30:01", "second", 34201n],
    ["09:30", "minute", 570n],
  ];
  for (const [text, type, n] of cases) {
    assert.deepStrictEqual(t.parse(text), { type, n }, text);
    assert.strictEqual(t.format({ type, n }), text);
  }
  // Short forms read as q reads them.
  assert.deepStrictEqual(t.parse("2024.01.02D03"), { type: "timestamp", n: 757479600000000000n });
  assert.deepStrictEqual(t.parse("1D02"), { type: "timespan", n: 93600000000000n });
  assert.strictEqual(t.parse("0001.01m").type, "month");
  assert.strictEqual(t.parse("0001.01.01").type, "date");
  assert.strictEqual(t.parse("0001.01.01T10:00").type, "datetime");
  // No such day, minute or month.
  // Nor a year 0, which q refuses (#1784); year 1 it reads.
  for (const bad of ["2023.02.29", "2024.13m", "09:60", "2024.01.02D24:00", "12:00:00.1234", "0Nx", "-0Np", "0wp", "0Wz", "0000.01m", "0000.01.01", "0000.12.31T10:00"]) {
    assert.strictEqual(t.parse(bad), undefined, bad);
  }
});

test("nulls and infinities are each type's own, and convert as q's casts do", () => {
  assert.deepStrictEqual(t.parse("0Np"), { type: "timestamp", special: "null", n: 0n });
  assert.deepStrictEqual(t.parse("-0Wd"), { type: "date", special: "-inf", n: 0n });
  assert.deepStrictEqual(t.parse("0wz"), { type: "datetime", special: "inf", n: 0n });
  assert.deepStrictEqual(texts("0Np"), ["0N", "0Nd"]);
  assert.deepStrictEqual(texts("0Wp"), ["0W", "0Wd"]);
  // 0Wp written out in full is still the infinity, not a date in 2292 (#1069).
  assert.deepStrictEqual(t.parse("2292.04.10D23:47:16.854775807"), { type: "timestamp", special: "inf", n: 0n });
  assert.deepStrictEqual(texts("2292.04.10D23:47:16.854775807"), ["0W", "0Wd"]);
  assert.deepStrictEqual(t.parse("2292.04.10D23:47:16.854775806").special, undefined);
  assert.deepStrictEqual(texts("-0Wd"), ["-0Wi", "-0Wp"]);
  assert.deepStrictEqual(texts("0Nt"), ["0Ni"]);
  assert.strictEqual(t.format({ type: "datetime", special: "-inf", n: 0n }), "-0wz");
});

test("a timestamp converts to its long, its date, Unix time in four units and ISO 8601, without drift", () => {
  const ts = t.convertText("2024.01.02D03:04:05.123456789");
  assert.strictEqual(ts.what, "timestamp");
  assert.deepStrictEqual(ts.conversions.map((c) => c.text), [
    "757479845123456789",
    "2024.01.02",
    "1704164645.123456789",
    "1704164645123.456789",
    "1704164645123456.789",
    "1704164645123456789",
    "2024-01-02T03:04:05.123456789Z",
  ]);
  // Each Unix form reads back as the same timestamp.
  for (const unit of t.UNIX_UNITS) {
    const text = ts.conversions.find((c) => c.label === `Unix ${unit.name}`).text;
    assert.strictEqual(t.format(t.fromUnix(text, unit.name)), "2024.01.02D03:04:05.123456789", unit.name);
  }
  // Before 2000, the date is the day it falls on, not the one after.
  assert.strictEqual(texts("1999.12.31D12:00:00")[1], "1999.12.31");
  // At the epoch.
  assert.deepStrictEqual(texts("2000.01.01D00:00:00.000000000").slice(0, 3), ["0", "2000.01.01", "946684800"]);
  // Outside the years KDB-X reads a literal in, the conversion is "p"$ of the long.
  assert.strictEqual(t.timestampText({ type: "timestamp", n: 9223372036854775806n }), '"p"$9223372036854775806');
});

test("a number converts as a q timestamp and as the Unix epoch its size suggests", () => {
  assert.deepStrictEqual(texts("1704164645"), ["2000.01.01D00:00:01.704164645", "2024.01.02D03:04:05.000000000", "2024-01-02T03:04:05Z"]);
  assert.deepStrictEqual(texts("1704164645123").slice(1), ["2024.01.02D03:04:05.123000000", "2024-01-02T03:04:05.123Z"]);
  assert.deepStrictEqual(texts("1704164645.5"), ["2024.01.02D03:04:05.500000000", "2024-01-02T03:04:05.5Z"]);
  assert.deepStrictEqual(texts("-9223372036854775808"), ["0Np"]);
  // The long's infinity is q's, though as Unix nanoseconds it is a time.
  assert.deepStrictEqual(texts("9223372036854775807"), ["0Wp", "2262.04.11D23:47:16.854775807", "2262-04-11T23:47:16.854775807Z"]);
  // More decimals than a nanosecond is no Unix time: nothing is rounded.
  assert.strictEqual(t.fromUnix("1.0000000001", "seconds"), undefined);
  assert.strictEqual(t.likelyUnit(11), undefined);
});

test("a hover finds the literal under the cursor, and nothing in a string, a comment or a word", () => {
  const at = (line, ch) => t.temporalAt(line, ch)?.text;
  assert.strictEqual(at("x:2024.01.02D03:04 + 1", 5), "2024.01.02D03:04");
  assert.strictEqual(at("select from t where time>09:30", 27), "09:30");
  assert.strictEqual(at("a-1704164645", 5), "1704164645");
  assert.strictEqual(at("f -0D00:00:01", 4), "-0D00:00:01");
  assert.strictEqual(at("x:0Np", 3), "0Np");
  assert.strictEqual(at('"2024.01.02"', 4), undefined);
  assert.strictEqual(at("/ 2024.01.02", 5), undefined);
  assert.strictEqual(at("x: 1 / 2024.01.02", 10), undefined);
  assert.strictEqual(at("v2024", 3), undefined);
  // A symbol or a file handle is no literal (#1417).
  assert.strictEqual(at("x:`2024.01.01", 5), undefined);
  assert.strictEqual(at("f `:1700000000", 6), undefined);
  assert.strictEqual(at("f `:/data/1700000000", 12), undefined);
  assert.strictEqual(at("x:1700000000", 5), "1700000000");
  // A short number is no time.
  assert.strictEqual(at("x:12345", 3), undefined);
  const md = t.hoverMarkdown(t.temporalAt("x:2024.01.02", 4));
  assert.match(md, /^\*\*date\*\* `2024\.01\.02`\n\n\| as \| value \|/);
  assert.match(md, /\| Unix seconds \| `1704153600` \|/);
});

test("the switch is declared, on by default, and the command is hidden when it is off", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.temporalHover.enable"].default, true);
  const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === t.CONVERT_TEMPORAL);
  assert.strictEqual(palette.when, "config.q-lint.temporalHover.enable");
});

/// An editor over `text`, one line, with `selected` (start, end) selected.
function fakeEditor(text, selected) {
  const editor = {
    text,
    document: {
      lineAt: () => ({ text: editor.text }),
      getText: (r) => editor.text.slice(r.start.character, r.end.character),
      offsetAt: (p) => p.character,
      positionAt: (o) => ({ line: 0, character: o }),
    },
    selection: { isEmpty: selected === undefined, active: { line: 0, character: selected?.[0] ?? 0 }, start: { line: 0, character: selected?.[0] }, end: { line: 0, character: selected?.[1] } },
    edit: async (f) => {
      f({ replace: (r, s) => (editor.text = editor.text.slice(0, r.start.character) + s + editor.text.slice(r.end.character)) });
      return true;
    },
  };
  return editor;
}

test("the hover lives only while the feature is on, and Convert replaces the selection or refuses", async () => {
  stub.reset();
  const registered = [];
  vscode.languages = {
    registerHoverProvider: (selector, provider) => {
      const entry = { provider, disposed: false, dispose() { this.disposed = true; } };
      registered.push(entry);
      return entry;
    },
  };
  vscode.Hover = class { constructor(contents, range) { Object.assign(this, { contents, range }); } };
  vscode.Range = class {
    constructor(a, b, c, d) {
      // (start, end) positions, or four numbers.
      if (typeof a === "object") Object.assign(this, { start: a, end: b });
      else Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d } });
    }
  };
  const { registerTemporal } = require("../out/temporalview.js");
  const context = stub.newContext();
  const api = registerTemporal(context);
  assert.strictEqual(api.registered(), true);
  const hover = registered[0].provider.provideHover({ lineAt: () => ({ text: "x:2024.01.02" }) }, { line: 0, character: 4 });
  assert.match(hover.contents.value, /\*\*date\*\*/);
  assert.deepStrictEqual(hover.range.start, { line: 0, character: 2 });
  // The cursor in a literal: it is replaced.
  vscode.window.activeTextEditor = fakeEditor("x:2024.01.02", undefined);
  vscode.window.activeTextEditor.selection.active.character = 5;
  assert.strictEqual(await stub.commands.get(t.CONVERT_TEMPORAL)("Unix seconds"), "1704153600");
  assert.strictEqual(vscode.window.activeTextEditor.text, "x:1704153600");
  // A selection, picked from the list.
  vscode.window.activeTextEditor = fakeEditor("ts:1704164645", [3, 13]);
  stub.picks.push((options) => options.items.find((i) => i.description === "from Unix seconds"));
  assert.strictEqual(await stub.commands.get(t.CONVERT_TEMPORAL)(), "2024.01.02D03:04:05.000000000");
  assert.strictEqual(vscode.window.activeTextEditor.text, "ts:2024.01.02D03:04:05.000000000");
  // The spaces a drag takes around the value are kept (#1783).
  vscode.window.activeTextEditor = fakeEditor("a 2024.01.02 b", [1, 13]);
  assert.strictEqual(await stub.commands.get(t.CONVERT_TEMPORAL)("int, days since 2000.01.01 (`\"i\"$`)"), "8767");
  assert.strictEqual(vscode.window.activeTextEditor.text, "a 8767 b");
  // Nothing to convert.
  vscode.window.activeTextEditor = fakeEditor("abc", [0, 3]);
  assert.strictEqual(await stub.commands.get(t.CONVERT_TEMPORAL)(), undefined);
  assert.match(stub.messages.at(-1)[1], /select a q temporal value/);
  // Off: the provider goes, the command refuses and changes nothing.
  stub.config.user["temporalHover.enable"] = false;
  stub.changeConfig("q-lint.temporalHover.enable");
  assert.strictEqual(registered[0].disposed, true);
  assert.strictEqual(api.registered(), false);
  assert.strictEqual(api.hover({ lineAt: () => ({ text: "x:2024.01.02" }) }, { line: 0, character: 4 }), undefined);
  vscode.window.activeTextEditor = fakeEditor("x:2024.01.02", [2, 12]);
  assert.strictEqual(await stub.commands.get(t.CONVERT_TEMPORAL)("Unix seconds"), undefined);
  assert.strictEqual(vscode.window.activeTextEditor.text, "x:2024.01.02");
  assert.match(stub.messages.at(-1)[1], /temporal hover and conversion is turned off\. Set q-lint\.temporalHover\.enable to true/);
  // On again, without a reload.
  stub.config.user["temporalHover.enable"] = true;
  stub.changeConfig("q-lint.temporalHover.enable");
  assert.strictEqual(api.registered(), true);
  for (const d of context.subscriptions) d.dispose?.();
  vscode.window.activeTextEditor = undefined;
});
