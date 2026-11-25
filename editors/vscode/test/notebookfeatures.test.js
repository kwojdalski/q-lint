// The notebook's later features, without an editor or a q process: the
// `/ @process` and `/ @parameters` directives (#950, #947), live values in
// Markdown cells (#949), export to HTML and Jupyter and import from Jupyter
// (#948), the headless run and its command line (#947), and the variables
// view's data (#946). notebookfeatures_q.test.js drives a real q.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const pkg = require("../package.json");
const { cellDirective } = require("../out/celldirectives.js");
const { LIVE, LIVE_KEY, inlineSpans, liveExpressions, liveQueries, markdownAfter, readLiveValues, scanLive } = require("../out/livemarkdown.js");
const { ESCAPE_CUT, FULL_TEXT, UTF8_CUT } = require("../out/qtext.js");
const { ERROR_MIME, fromIpynb, markdownHtml, toHtml, toIpynb, IpynbError } = require("../out/qnbconvert.js");
const { INJECTED_KEY, cliProcess, guardedText, injectParameters, parametersCell, parametersOf, parseArgs, passwordOf, passwordVariable, runNotebook, writeAs } = require("../out/qnbrun.js");
const { isProduction } = require("../out/agent.js");
const { writes } = require("../out/guard.js");
const { describeVariable, readVariables, bytesText, VARS } = require("../out/notebookvars.js");
const { NOTEBOOK, parseQnb, serializeQnb } = require("../out/qnb.js");

// --- directives

test("/ @process names the process a cell runs on, beside its output mode", () => {
  assert.deepStrictEqual(cellDirective("/ @process rdb\n1+1"), { mode: "console", process: "rdb" });
  assert.deepStrictEqual(cellDirective("/ @grid\n/ @process desk/hdb 2\nt"), { mode: "grid", process: "desk/hdb 2" });
  assert.deepStrictEqual(cellDirective("/ @chart bar\n/ @process r\n/ @title T\nt"), { mode: "chart", chart: "bar", title: "T", process: "r" });
  assert.match(cellDirective("/ @process\n1").problem, /takes the label/);
  // Not a directive below the first statement.
  assert.deepStrictEqual(cellDirective("1\n/ @process rdb"), { mode: "console" });
});

test("/ @parameters marks the parameters cell and takes nothing", () => {
  assert.deepStrictEqual(cellDirective("/ @parameters\nd:2024.01.01"), { mode: "console", parameters: true });
  assert.match(cellDirective("/ @parameters x\nd:1").problem, /takes nothing/);
  assert.match(cellDirective("/ @nope\n1").problem, /`\/ @process <label>` and `\/ @parameters`/);
});

// --- live values

test("a live value's expression runs to its }}, braces and q strings balanced", () => {
  assert.deepStrictEqual(scanLive("{{q: 1+1}} after", 0), { expr: "1+1", end: 10 });
  assert.deepStrictEqual(scanLive("{{q: {x+1} 41}}", 0), { expr: "{x+1} 41", end: 15 });
  assert.deepStrictEqual(scanLive('{{q: count "}}"}}', 0), { expr: 'count "}}"', end: 17 });
  assert.strictEqual(scanLive("{{q: 1+1}", 0), undefined);
  assert.strictEqual(scanLive("{{q:   }}", 0), undefined);
  assert.strictEqual(scanLive("{{q: a\n\nb}}", 0), undefined);
  // A line of blanks, or a CRLF blank line, ends the paragraph too (#1468).
  assert.strictEqual(scanLive("{{q: a\n \t\nb}}", 0), undefined);
  assert.strictEqual(scanLive("{{q: a\r\n\r\nb}}", 0), undefined);
  assert.deepStrictEqual(liveExpressions("a {{q: 1+\n \n2}} b"), []);
  assert.deepStrictEqual(scanLive("{{q: a\r\nb}}", 0), { expr: "a\n b", end: 11 });
});

test("expressions are found once each, never in code; a q symbol's backtick opens no code span", () => {
  const md = [
    "# {{q: string .z.d}}",
    "Total **{{q: sum t`px}}**, `{{q: in code}}` and {{q: string .z.d}}.",
    "```q",
    "{{q: in a block}}",
    "```",
    "Last {{q: count t}} and \\{{q: escaped}}",
  ].join("\n");
  assert.deepStrictEqual(liveExpressions(md), ["string .z.d", "sum t`px", "count t"]);
  assert.deepStrictEqual(inlineSpans("a `x` {{q: 1}}").map((s) => s.kind), ["code", "live"]);
});

test("an indented code block or an HTML comment holds no live value (#1429)", () => {
  assert.deepStrictEqual(liveExpressions("Para\n\n    {{q: indented}}\n"), []);
  // A fence closes only at a line of the fence alone, blanks after (#1469).
  assert.deepStrictEqual(liveExpressions("```\n``` not a closer\n{{q: secret}}\n```\n"), []);
  assert.deepStrictEqual(liveExpressions("~~~\n~~~x\n{{q: secret}}\n~~~\n"), []);
  assert.deepStrictEqual(liveExpressions("```\n~~~\n{{q: in}}\n````  \n{{q: out}}"), ["out"]);
  assert.deepStrictEqual(liveExpressions("```\r\ncode\r\n```\r\n{{q: out}}"), ["out"]);
  assert.deepStrictEqual(liveExpressions("    {{q: first}}\n\tand {{q: tab}}\n\nAfter {{q: a}}"), ["a"]);
  assert.deepStrictEqual(liveExpressions("<!-- {{q: hidden}} -->"), []);
  assert.deepStrictEqual(liveExpressions("A <!--\n{{q: hidden}}\n--> and {{q: b}}"), ["b"]);
  // Indented under a paragraph line or a list item it is text, and live.
  assert.deepStrictEqual(liveExpressions("Para\n    {{q: lazy}}"), ["lazy"]);
  assert.deepStrictEqual(liveExpressions("- item\n\n    {{q: in list}}"), ["in list"]);
});

// markdown-it reads a link's target and a reference definition without
// its inline rules, so the renderer drew nothing there, yet the code cell
// above ran the expression with it (#1827).
test("a live value in a link's target, a reference definition or an image's alt text is not run", () => {
  for (const hidden of [
    '[x]: {{q:system"id"}}',
    '[docs](<https://kx.com/{{q: system "touch /tmp/pwn"}}>)',
    '![a](<b {{q: system "id"}}>)',
    "[a](http://x/{{q:1}})",
    '[l](u "{{q:1}}")',
    "![{{q:1}}](u)",
    "<http://x/{{q:1}}>",
    "[t][{{q:1}}]",
    "[x]:\n  {{q:1}}",
    '[x]: /u\n"t {{q:1}}"',
    "> [x]: {{q:1}}",
  ]) {
    assert.deepStrictEqual(liveExpressions(hidden), [], hidden);
  }
  // A link's text is drawn, and a live value met before a link is one.
  assert.deepStrictEqual(liveExpressions("see [{{q: a}}](u) and {{q: b}}"), ["a", "b"]);
  assert.deepStrictEqual(liveExpressions("x {{q: f[1](2)}}"), ["f[1](2)"]);
  assert.deepStrictEqual(liveExpressions("[x]: /u\nshown {{q: c}}"), ["c"]);
  assert.deepStrictEqual(liveExpressions("`[a](`{{q: d}}`)`"), ["d"]);
});

test("the Markdown after a code cell is read when it runs; the first code cell reads what is above it", () => {
  const cells = ["markdown", "markdown", "code", "markdown", "code", "code", "markdown"].map((kind) => ({ kind }));
  assert.deepStrictEqual(markdownAfter(cells, 2), [0, 1, 3]);
  assert.deepStrictEqual(markdownAfter(cells, 4), []);
  assert.deepStrictEqual(markdownAfter(cells, 5), [6]);
});

test("the live lambda's answer is read by expression; anything else is refused", () => {
  assert.deepStrictEqual(readLiveValues(["a", "b"], [[true, "2"], [false, "type"]]), { a: { text: "2" }, b: { error: "type" } });
  assert.throws(() => readLiveValues(["a"], { ok: 1 }), /1 live values/);
  // One lambda, nothing assigned on the process.
  assert.match(LIVE, /^\{\[es\]/);
  // FULL_TEXT and the cuts have locals of their own: qtext_q.test.js holds that they define nothing.
  assert.ok(LIVE.includes(FULL_TEXT));
  assert.doesNotMatch(LIVE.replace(FULL_TEXT, "").split(ESCAPE_CUT).join("").split(UTF8_CUT).join("").replace(/\b[rv]:/g, ""), /[a-zA-Z_.]+::?[^:]/);
});

/// media/livemarkdown.js, the renderer's extension, as the editor loads it:
/// an ES module.
async function renderer() {
  const source = fs.readFileSync(path.join(__dirname, "..", "media", "livemarkdown.js"), "utf8");
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test("the renderer reads expressions as the extension does, and escapes every value", async () => {
  const r = await renderer();
  for (const text of ["{{q: 1+1}}", "{{q: {x+1} 41}}", '{{q: count "}}"}}', "{{q: 1+1}", "{{q: a\n\nb}}", "{{q: sum t`px}}"]) {
    assert.deepStrictEqual(r.scanLive(text, 0), scanLive(text, 0), text);
  }
  const values = { a: { text: "<img src=x onerror=alert(1)>" }, b: { error: "<b>" } };
  assert.strictEqual(r.liveHtml("a", values), '<span class="qlint-live" title="q: a">&lt;img src=x onerror=alert(1)&gt;</span>');
  assert.match(r.liveHtml("b", values), />'&lt;b&gt;<\/span>$/);
  assert.strictEqual(r.liveHtml('<x">', {}), '<code title="Runs when the code cell above this one runs">{{q: &lt;x&quot;&gt;}}</code>');
  // A prototype's name is no value.
  assert.match(r.liveHtml("constructor", {}), /^<code/);
});

test("a live value in a blockquote, a list item or a CRLF cell is keyed as the renderer reads it (#1788)", async () => {
  const r = await renderer();
  for (const source of ["> total {{q: sum\n> til 4}}", "- total {{q: sum\n  til 4}}", "total {{q: sum\r\ntil 4}}", "total {{q: sum\n til 4}}"]) {
    assert.deepStrictEqual(liveExpressions(source), ["sum\n til 4"], JSON.stringify(source));
  }
  // What markdown-it hands the renderer, the markers and indent gone.
  assert.strictEqual(r.scanLive("total {{q: sum\ntil 4}}", 6).expr, "sum\n til 4");
});

// A `>` four columns or more into a continuation line is no blockquote
// marker to markdown-it: it is q's greater-than. The key keeps it on both
// sides, and the process is sent the text as written, not the key (#1993).
test("a continuation line's own > is q's: kept in the key, and sent as written (#1993)", async () => {
  const r = await renderer();
  // The source, what markdown-it hands the renderer for it, the key, and
  // the expression sent.
  for (const [source, inline, key, expr] of [
    ["Big: {{q: 5\n    >3}}", "Big: {{q: 5\n    >3}}", "5\n >3", "5\n    >3"],
    ["Big: {{q: 5\n\t>3}}", "Big: {{q: 5\n\t>3}}", "5\n >3", "5\n\t>3"],
    ["Ok: {{q: 3 4 5\r\n    >=4}}", "Ok: {{q: 3 4 5\n    >=4}}", "3 4 5\n >=4", "3 4 5\r\n    >=4"],
    ["- item {{q: 5\n      >3}}", "item {{q: 5\n    >3}}", "5\n >3", "5\n      >3"],
    // In a blockquote its own markers go, and only they.
    ["> a {{q: 5\n>     >3}}", "a {{q: 5\n    >3}}", "5\n >3", "5\n    >3"],
    ["> a {{q: 5\n    >3}}", "a {{q: 5\n3}}", "5\n 3", "5\n3"],
    ["> > a {{q: sum\n> > til 4}}", "a {{q: sum\ntil 4}}", "sum\n til 4", "sum\ntil 4"],
    // A string's lines are sent as written.
    ['s {{q: "a\n   b"}}', 's {{q: "a\n   b"}}', '"a\n b"', '"a\n   b"'],
  ]) {
    assert.deepStrictEqual(liveQueries(source), [{ key, expr }], JSON.stringify(source));
    assert.strictEqual(r.scanLive(inline, inline.indexOf("{{q:")).expr, key, JSON.stringify(inline));
  }
  // With and without the `>` are two expressions, not one key.
  assert.deepStrictEqual(liveExpressions("{{q: x\n    >y}} {{q: x\n    y}}"), ["x\n >y", "x\n y"]);
  // The guard reads what is sent.
  assert.deepStrictEqual(guardedText("1", ["{{q: 5\n    >3}}", "> {{q: sum\n> til 4}}"]), ["1", { valued: "5\n    >3" }, { valued: "sum\ntil 4" }]);
});

// A fence, an indented code block and an HTML block are that in a
// blockquote and in a list item as at the cell's top: the renderer shows
// their `{{q: }}` as written, so the process is never asked for it (#2000).
test("a code or HTML block inside a blockquote or a list item is not prose: its live values are not run (#2000)", async () => {
  const r = await renderer();
  for (const hidden of [
    "> ~~~\n> {{q: x}}\n> ~~~",
    "> <div>\n> {{q: x}}\n> </div>",
    "- a\n\n      {{q: x}}",
    "- ~~~\n  {{q: x}}\n  ~~~",
    "1. <pre>\n   {{q: x}}\n   </pre>",
    ">     {{q: x}}",
    "> - a\n>\n>       {{q: x}}",
    "- > ```\n  > {{q: x}}",
    // A comment's block reads on over the item's empty line.
    "- <!--\n\n  {{q: x}}",
    // After a link reference definition a line four columns in is code.
    "[x]: /u\n    {{q: x}}",
    // A code span is read before the comment opened in it.
    "`{{q: x}}<!--`",
    "a <!A {{q: x}}> b <?{{q: x}}?>",
  ]) {
    assert.deepStrictEqual(liveQueries(hidden), [], JSON.stringify(hidden));
  }
  // What is prose there is read as before. The source, what markdown-it
  // hands the renderer for its blocks, and the keys.
  for (const [source, inline, keys] of [
    // The block ends, and prose follows it in the same container.
    ["> ~~~\n> {{q: x}}\n> ~~~\n> after {{q: a}}", ["after {{q: a}}"], ["a"]],
    ["- <div>\n  {{q: x}}\n\n  {{q: d}}", ["{{q: d}}"], ["d"]],
    ["- a\n- b\n\n      {{q: x}}\n- c {{q: f}}", ["a", "b", "c {{q: f}}"], ["f"]],
    // A line without the quote's `>` is not in its fence.
    ["> ~~~\n{{q: out}}", ["{{q: out}}"], ["out"]],
    // Four columns in is code only past the item's own indent.
    ["- a\n\n    {{q: c}}", ["a", "{{q: c}}"], ["c"]],
    ["1. a\n\n   {{q: b}}\n\n       {{q: x}}", ["a", "{{q: b}}"], ["b"]],
    // A comment never closed in a paragraph is text, as is `[x]:` with no
    // destination after it.
    ["a <!-- {{q: g}}", ["a <!-- {{q: g}}"], ["g"]],
    ["[x]:{{q: h}} i", ["[x]:{{q: h}} i"], ["h"]],
  ]) {
    assert.deepStrictEqual(liveExpressions(source), keys, JSON.stringify(source));
    assert.deepStrictEqual(inline.flatMap((text) => inlineSpans(text).filter((sp) => sp.kind === "live").map((sp) => r.scanLive(text, sp.start).expr)), keys, JSON.stringify(inline));
  }
  // The guard reads none of what is not run.
  assert.deepStrictEqual(guardedText("1", ["> ~~~\n> {{q: `t set 1}}\n> ~~~", "- a\n\n      {{q: delete from `t}}"]), ["1"]);
});

// markdown-it splits a table's row at each `|` before any inline rule and
// hands a cell's `\|` over as `|`. The host read the row as written: it
// ran `1|2` for a row that showed nothing, and sent q `1\|2`, which it
// refuses, for the row that showed the value (#1999).
test("a live value in a table cell is read as the cell's text: its \\| is q's |, and one the row splits is not run (#1999)", async () => {
  const r = await renderer();
  const table = (row) => `| a | b |\n|---|---|\n${row}`;
  assert.deepStrictEqual(liveQueries(table("| {{q: 1\\|2}} | x |")), [{ key: "1|2", expr: "1|2" }]);
  // The key the page looks up, from the cell's text as markdown-it hands it.
  assert.strictEqual(r.scanLive("{{q: 1|2}}", 0).expr, "1|2");
  // Unescaped, the row splits inside it: two cells of text, and no query.
  assert.deepStrictEqual(liveQueries(table("| {{q: 1|2}} | x |")), []);
  assert.deepStrictEqual(guardedText("1", [table("| {{q: `t set 1|2}} | x |")]), ["1"]);
  assert.deepStrictEqual(guardedText("1", [table("| {{q: `t set 1\\|2}} | x |")]), ["1", { valued: "`t set 1|2" }]);
  // The header's cells are read so too, and a cell past its last is not shown.
  assert.deepStrictEqual(liveExpressions("| {{q: a\\|b}} | {{q: c}} |\n|---|---|"), ["a|b", "c"]);
  assert.deepStrictEqual(liveExpressions(table("| {{q: d}} | e | {{q: f}} |\n\n{{q: g}}")), ["d", "g"]);
  // In a quote and a list item, and with CRLF line ends.
  assert.deepStrictEqual(liveExpressions("> | a |\n> |---|\n> | {{q: 1\\|2}} |\n\n- | a |\n  |---|\n  | {{q: 3\\|4}} |"), ["1|2", "3|4"]);
  assert.deepStrictEqual(liveQueries(table("| {{q: 1\\|2}} | x |").replace(/\n/g, "\r\n")), [{ key: "1|2", expr: "1|2" }]);
  // With no line of dashes under it a row is a paragraph, sent as written.
  assert.deepStrictEqual(liveQueries("| {{q: 1|2}} | x |"), [{ key: "1|2", expr: "1|2" }]);
  assert.deepStrictEqual(liveQueries("| {{q: 1\\|2}} | x |"), [{ key: "1\\|2", expr: "1\\|2" }]);
});

/// The lines generated Markdown is made of: the containers a line opens or
/// goes on in, and what it holds.
const PREFIXES = ["", "", "", "> ", ">", "- ", "* ", "1. ", "  ", "    ", "      ", "\t", "> > ", "> - ", "- > ", ">     ", "   > "];
const BODIES = ["{{q: K}}", "{{q: K}}", "text {{q: K}}", "text", "", "", "```", "~~~", "``` q", "~~~ {{q: K}}", "<div>", "</div>", "<pre>", "</pre>", "<!--", "-->", "<span>", "<!A", "<?", "?>", "<script>", "---", "===", "# {{q: K}}", "<b>{{q: K}}</b>", "`{{q: K}}`", "- {{q: K}}", "> {{q: K}}", "-", "{{q: K", "K}}", "[x]: /u", "[x]: {{q: K}}", "[x]:", '"t {{q: K}}"', "{{q: K}} <!--", "<div> {{q: K}}"];
/// A table's lines among them (#1999).
BODIES.push("| {{q: K}} | {{q: K\\|1}} |", "{{q: K|2}} | x", "| a | b |", "|---|---|", "---|---", "|-|", "| {{q: K}} |", "x \\| {{q: K}} | y | {{q: 3\\|K}}", ":-:|-:", "{{q: K}} \\\\| w");

// markdown-it itself is the judge: the renderer VS Code ships, when
// QLINT_TEST_MARKDOWN_IT names its notebook-out/index.js.
test("over generated Markdown the extension runs the live values markdown-it draws, and no other (#2000)", { skip: process.env.QLINT_TEST_MARKDOWN_IT ? false : "QLINT_TEST_MARKDOWN_IT names no markdown-it renderer" }, async () => {
  const r = await renderer();
  const element = () => ({ classList: { add() {} }, content: { appendChild() {} }, appendChild() {}, textContent: "", style: {}, setAttribute() {} });
  const had = globalThis.document;
  globalThis.document = { documentElement: { style: { getPropertyValue: () => "" } }, createElement: element, head: { appendChild() {} }, body: { appendChild() {} } };
  let md;
  try {
    const bundled = await import(url.pathToFileURL(process.env.QLINT_TEST_MARKDOWN_IT).href);
    const api = await bundled.activate({ workspace: { isTrusted: true }, onDidChangeSettings() {}, settings: {}, postMessage() {} });
    api.extendMarkdownIt((m) => (md = m));
  } finally {
    globalThis.document = had;
  }
  let drawn = [];
  r.extend(md, (expr) => drawn.push(expr));
  let seed = 2000;
  const random = (n) => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const pick = (from) => from[random(from.length)];
  let withValues = 0;
  for (let doc = 0; doc < 20000; doc++) {
    const lines = [];
    for (let k = random(6); k >= 0; k--) {
      lines.push(pick(PREFIXES) + (random(5) === 0 ? pick(PREFIXES) : "") + pick(BODIES).replace(/K/g, () => `k${lines.length}`));
    }
    const source = lines.join(random(20) === 0 ? "\r\n" : "\n");
    drawn = [];
    md.render(source, { outputItem: { metadata: {} } });
    assert.deepStrictEqual([...liveExpressions(source)].sort(), [...new Set(drawn)].sort(), JSON.stringify(source));
    withValues += drawn.length > 0 ? 1 : 0;
  }
  // Nearly half draw one, so this is not nothing compared with nothing.
  assert.ok(withValues > 5000, `${withValues} documents drew a live value`);
});

test("the renderer reports a prototype's name as having no value, which postMessage can clone (#1391)", async () => {
  const r = await renderer();
  const rules = {};
  const md = { inline: { ruler: { before: (_at, _name, rule) => (rules.inline = rule) } }, renderer: { rules } };
  const heard = [];
  r.extend(md, (expr, value) => heard.push(structuredClone({ expr, value: value ?? null })));
  const env = { outputItem: { metadata: { "q-lint.liveValues": { a: { text: "1" } } } } };
  const html = ["constructor", "toString", "a"].map((expr) => rules.qlint_live([{ meta: { expr } }], 0, {}, env));
  assert.deepStrictEqual(heard, [{ expr: "constructor", value: null }, { expr: "toString", value: null }, { expr: "a", value: { text: "1" } }]);
  assert.match(html[0], /^<code/);
});

test("package.json contributes the live values renderer as an extension of the Markdown renderer", () => {
  const live = pkg.contributes.notebookRenderer.find((r) => r.id === NOTEBOOK.liveRenderer);
  assert.deepStrictEqual(live.entrypoint, { extends: "vscode.markdown-it-renderer", path: "./media/livemarkdown.js" });
  const source = fs.readFileSync(path.join(__dirname, "..", live.entrypoint.path), "utf8");
  assert.match(source, /^export async function activate\(/m);
  assert.match(source, /const LIVE_KEY = "q-lint\.liveValues";/);
  assert.strictEqual(LIVE_KEY, "q-lint.liveValues");
  assert.doesNotMatch(source, /^import /m);
});

// --- export and import

const RUN = {
  cells: [
    { kind: "markdown", source: "# Prices <script>alert(1)</script>\n\nTotal **{{q: sum px}}**, see [docs](https://code.kx.com/q?a=1&b=2) not [this](javascript:alert(1)).\n\n- one\n- `two<`", metadata: { [LIVE_KEY]: { "sum px": { text: "<7.5>" } } } },
    {
      kind: "code",
      source: "/ @grid\nt:([] s:enlist \"</pre><script>\")\nt",
      execution: { order: 1, success: true },
      outputs: [{ items: [{ mime: "text/html", text: "<table><script>alert(1)</script></table>" }, { mime: "text/plain", text: "s\n---\n</pre><script>" }] }],
    },
    { kind: "code", source: "1+`a", execution: { order: 2, success: false }, outputs: [{ items: [{ mime: ERROR_MIME, text: JSON.stringify({ name: "q error", message: "'type", stack: "'type\n  [0] 1+`a" }) }] }] },
    { kind: "code", source: "print(1)", language: "python" },
    { kind: "code", source: "x", outputs: [{ items: [{ mime: "image/png", base64: "iVBORw0KGgo=" }] }] },
  ],
};

test("an HTML export escapes everything from the notebook, copies no output HTML, and runs no script", () => {
  const html = toHtml(RUN, "prices<1>.qnb");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<title>prices&lt;1&gt;\.qnb<\/title>/);
  assert.match(html, /<h1>Prices &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /<strong><span class="live" title="q: sum px">&lt;7\.5&gt;<\/span><\/strong>/);
  assert.match(html, /<a href="https:\/\/code\.kx\.com\/q\?a=1&amp;b=2">docs<\/a>/);
  assert.match(html, /<li><code>two&lt;<\/code><\/li>/);
  assert.match(html, /<pre class="out">s\n---\n&lt;\/pre&gt;&lt;script&gt;<\/pre>/);
  assert.match(html, /<pre class="out error">&#39;type\n  \[0\] 1\+`a<\/pre>/);
  assert.match(html, /python \[ \]/);
  assert.match(html, /<img class="out" alt="" src="data:image\/png;base64,iVBORw0KGgo=">/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
});

test("Markdown without a value shows its expression as written", () => {
  assert.strictEqual(markdownHtml("n is {{q: n}}"), "<p>n is <code>{{q: n}}</code></p>");
  assert.strictEqual(markdownHtml("> quoted *a*\n\n1. x\n2. y"), "<blockquote><p>quoted <em>a</em></p></blockquote>\n<ol><li>x</li><li>y</li></ol>");
  // A link's URL is not read for emphasis; its label is (#1105).
  assert.strictEqual(markdownHtml("[docs](https://code.kx.com/q/ref/_x_/)"), '<p><a href="https://code.kx.com/q/ref/_x_/">docs</a></p>');
  // A quote or angle bracket in the URL is escaped once, not twice (#1476).
  assert.strictEqual(markdownHtml("see [docs](https://en.wikipedia.org/wiki/Hoare's_logic) now"), '<p>see <a href="https://en.wikipedia.org/wiki/Hoare&#39;s_logic">docs</a> now</p>');
  assert.match(markdownHtml("[q](https://x.io/?q=a<b)"), /href="https:\/\/x\.io\/\?q=a&lt;b"/);
  assert.strictEqual(markdownHtml("[*a*](https://x.io/a*b*c) and *b*"), '<p><a href="https://x.io/a*b*c"><em>a</em></a> and <em>b</em></p>');
});

test("a Jupyter export is nbformat 4 with q's kernel, other languages and errors as Jupyter writes them", () => {
  const nb = JSON.parse(toIpynb(RUN));
  assert.strictEqual(nb.nbformat, 4);
  assert.strictEqual(nb.metadata.kernelspec.language, "q");
  assert.deepStrictEqual(nb.cells[0].metadata, RUN.cells[0].metadata);
  assert.deepStrictEqual(nb.cells[1].source, ["/ @grid\n", "t:([] s:enlist \"</pre><script>\")\n", "t"]);
  assert.strictEqual(nb.cells[1].outputs[0].output_type, "execute_result");
  assert.strictEqual(nb.cells[1].outputs[0].execution_count, 1);
  assert.deepStrictEqual(nb.cells[2].outputs[0], { output_type: "error", ename: "q error", evalue: "'type", traceback: ["'type", "  [0] 1+`a"] });
  assert.deepStrictEqual(nb.cells[3].metadata, { vscode: { languageId: "python" } });
  assert.strictEqual(nb.cells[4].outputs[0].output_type, "display_data");
  assert.strictEqual(nb.cells[4].outputs[0].data["image/png"], "iVBORw0KGgo=");
});

test("a notebook exported to Jupyter and imported again is the same notebook", () => {
  const back = fromIpynb(toIpynb(RUN));
  assert.strictEqual(back.cells.length, RUN.cells.length);
  back.cells.forEach((cell, i) => {
    const want = RUN.cells[i];
    assert.strictEqual(cell.kind, want.kind);
    assert.strictEqual(cell.source, want.source);
    assert.strictEqual(cell.language, want.language);
    assert.deepStrictEqual(cell.outputs?.map((o) => o.items), want.outputs?.map((o) => o.items));
    assert.strictEqual(cell.execution?.order, want.execution?.order);
  });
  assert.deepStrictEqual(back.cells[0].metadata, RUN.cells[0].metadata);
  // And it is a .qnb that reads back.
  assert.strictEqual(parseQnb(serializeQnb(back)).cells.length, 5);
});

test("a Python notebook imports with its code as Python, a %%q cell as q, and its outputs kept", () => {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { language: "python", name: "python3" }, language_info: { name: "python" } },
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# Title\n", "text"], attachments: { "a.png": {} } },
      { cell_type: "code", execution_count: 3, metadata: {}, source: "import pykx as kx", outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }] },
      { cell_type: "code", execution_count: null, metadata: {}, source: ["%%q\n", "til 3"], outputs: [] },
      { cell_type: "code", metadata: { vscode: { languageId: "q" } }, source: ["1+1"], outputs: [{ output_type: "error", ename: "E", evalue: "v", traceback: ["\u001b[31mred\u001b[0m"] }] },
      { cell_type: "raw", metadata: {}, source: "raw text" },
      { cell_type: "code", metadata: {}, source: "plt.plot()", outputs: [{ output_type: "display_data", data: { "image/png": "iVBO\nRw==", "text/plain": ["<Figure>"] }, metadata: {} }] },
    ],
  };
  const qnb = fromIpynb(JSON.stringify(nb));
  assert.deepStrictEqual(qnb.cells.map((c) => [c.kind, c.language]), [
    ["markdown", undefined],
    ["code", "python"],
    ["code", undefined],
    ["code", undefined],
    ["code", "raw"],
    ["code", "python"],
  ]);
  assert.strictEqual(qnb.cells[0].source, "# Title\ntext");
  assert.deepStrictEqual(qnb.cells[0].extra, { attachments: { "a.png": {} } });
  assert.strictEqual(qnb.cells[1].execution.order, 3);
  assert.deepStrictEqual(qnb.cells[1].outputs[0].items, [{ mime: "application/vnd.code.notebook.stdout", text: "hi\n" }]);
  assert.strictEqual(qnb.cells[2].source, "til 3");
  assert.strictEqual(qnb.cells[3].metadata, undefined);
  assert.strictEqual(JSON.parse(qnb.cells[3].outputs[0].items[0].text).stack, "red");
  assert.deepStrictEqual(qnb.cells[5].outputs[0].items[0], { mime: "image/png", base64: "iVBORw==" });
  // A raw cell goes back to Jupyter as a raw cell (#1107).
  assert.deepStrictEqual(JSON.parse(toIpynb(qnb)).cells[4], { cell_type: "raw", metadata: {}, source: ["raw text"] });
  // What is not a notebook is refused, with why.
  assert.throws(() => fromIpynb("{"), IpynbError);
  assert.throws(() => fromIpynb('{"nbformat": 3, "cells": []}'), /nbformat 3/);
  assert.throws(() => fromIpynb("[]"), /expected a JSON object with "cells"/);
});

test("a heading keeps a # that ends a word, and drops a closing run after a space (#1237)", () => {
  assert.strictEqual(markdownHtml("# Using C#"), "<h1>Using C#</h1>");
  assert.strictEqual(markdownHtml("## Title ##"), "<h2>Title</h2>");
  assert.strictEqual(markdownHtml("# F# and C# #"), "<h1>F# and C#</h1>");
  assert.strictEqual(markdownHtml("# ##"), "<h1></h1>");
});

test("a markdown or raw cell's attachments go back to Jupyter (#1234)", () => {
  const png = { "image/png": "iVBORw==" };
  const nb = {
    nbformat: 4,
    metadata: { kernelspec: { language: "q", name: "qpk" } },
    cells: [
      { cell_type: "markdown", metadata: {}, source: "![x](attachment:a.png)", attachments: { "a.png": png } },
      { cell_type: "raw", metadata: {}, source: "r", attachments: { "b.png": png } },
    ],
  };
  const back = JSON.parse(toIpynb(fromIpynb(JSON.stringify(nb))));
  assert.deepStrictEqual(back.cells[0].attachments, { "a.png": png });
  assert.deepStrictEqual(back.cells[1].attachments, { "b.png": png });
});

test("a jupyterq notebook's code cells are q", () => {
  const qnb = fromIpynb(JSON.stringify({ nbformat: 4, metadata: { kernelspec: { language: "q", name: "qpk" } }, cells: [{ cell_type: "code", source: "til 3", metadata: {}, outputs: [] }] }));
  assert.strictEqual(qnb.cells[0].language, undefined);
});

// --- parameters and the headless run

test("a parameters cell's assignments are its parameters", () => {
  assert.deepStrictEqual(parametersOf("/ @parameters\nd:2024.01.01;\nsyms:`EURUSD`GBPUSD / the pairs\n.cfg.n: 10\nf:{x}\nx::1\n/ a note"), [
    { name: "d", value: "2024.01.01" },
    { name: "syms", value: "`EURUSD`GBPUSD" },
    { name: ".cfg.n", value: "10" },
    { name: "f", value: "{x}" },
    { name: "x", value: "1" },
  ]);
  // Each assignment of a line of several (#2387), and one with `::` (#2388);
  // a `;` in a string or in brackets is the value's.
  assert.deepStrictEqual(parametersOf("/ @parameters\nstart:2024.01.01;end:2024.01.31\nsym:`EURUSD\nrows::100\nf:{x;y};s:\"a;b\";l:(1;2)"), [
    { name: "start", value: "2024.01.01" },
    { name: "end", value: "2024.01.31" },
    { name: "sym", value: "`EURUSD" },
    { name: "rows", value: "100" },
    { name: "f", value: "{x;y}" },
    { name: "s", value: '"a;b"' },
    { name: "l", value: "(1;2)" },
  ]);
  // A " /" inside a string is not a comment (#1118).
  assert.deepStrictEqual(parametersOf('path:"/data /hdb"; / where\nq:"a\\" /b"\nn:1 ;'), [
    { name: "path", value: '"/data /hdb"' },
    { name: "q", value: '"a\\" /b"' },
    { name: "n", value: "1" },
  ]);
  // One in a block comment, or a line of a multi-line string, is none (#1470).
  assert.deepStrictEqual(parametersOf('/ @parameters\n/\nold:5\n\\\nn:10\ns:"a\n  b:2"'), [{ name: "n", value: "10" }]);
  // An indented comment line after a parameter leaves it one (#1732); in a
  // string, or after a line that continues, it does not.
  assert.deepStrictEqual(parametersOf("a:1\n  / note\nb:2"), [{ name: "a", value: "1" }, { name: "b", value: "2" }]);
  assert.deepStrictEqual(parametersOf('s:"x\n  / y"\nc:1\n  +2\n  / z\nd:3'), [{ name: "d", value: "3" }]);
  const cells = [{ kind: "markdown", source: "/ @parameters" }, { kind: "code", source: "1" }, { kind: "code", source: "/ @parameters\nn:1" }];
  assert.strictEqual(parametersCell(cells), 2);
  assert.strictEqual(parametersCell([{ kind: "code", source: "/ @parameters", language: "python" }]), -1);
});

test("given values go in a cell after the parameters cell, replacing an earlier run's", () => {
  const cells = [{ kind: "code", source: "a:1" }, { kind: "code", source: "/ @parameters\nn:1" }, { kind: "code", source: "n" }];
  const once = injectParameters(cells, { n: "5", s: "`x" });
  assert.deepStrictEqual(once[2], { kind: "code", source: "/ Parameters given to this run.\nn:5;\ns:`x;", metadata: { [INJECTED_KEY]: true } });
  const twice = injectParameters(once, { n: "6" });
  assert.strictEqual(twice.length, 4);
  assert.strictEqual(twice[2].source, "/ Parameters given to this run.\nn:6;");
  // No parameters cell: at the top. No values: none, and an old one goes.
  assert.strictEqual(injectParameters([{ kind: "code", source: "n" }], { n: "1" })[0].metadata[INJECTED_KEY], true);
  assert.deepStrictEqual(injectParameters(once, {}), cells);
});

/// An executor whose connection answers each statement list from `answer`,
/// recording the process each cell went to.
function fakeExecutor(answer) {
  const sent = [];
  const codes = [];
  return {
    sent,
    codes,
    on: async (label, code, use) => {
      sent.push(label ?? "default");
      codes.push(code);
      return use({
        query: async (cut) => answer(cut),
        call: async (lambda, arg) => (lambda.startsWith("{[es]") ? arg.map((e) => [true, `v(${e})`]) : answer(arg)),
        queryGrid: async () => ({ ok: true, type: 98, text: [] }),
      });
    },
  };
}
const SETTINGS = { consoleSize: [25, 80], rows: 1000, rowLimitFrom: "first" };

test("a headless run numbers and runs the q cells, reads live values, and goes where @process says", async () => {
  const qnb = {
    cells: [
      { kind: "markdown", source: "Top {{q: a}}" },
      { kind: "code", source: "/ @parameters\nn:1" },
      { kind: "code", source: "/ @process other\nn*2" },
      { kind: "markdown", source: "n is {{q: n}}", metadata: { keep: 1 } },
      { kind: "code", source: "print(1)", language: "python", outputs: [{ items: [{ mime: "text/plain", text: "1" }] }] },
    ],
  };
  const ex = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  const seen = [];
  const run = await runNotebook(qnb, ex, SETTINGS, { n: "5" }, { progress: (c, of) => seen.push(`${c}/${of}`) });
  assert.strictEqual(run.failed, undefined);
  assert.strictEqual(run.ran, 3);
  assert.deepStrictEqual(ex.sent, ["default", "default", "other"]);
  assert.deepStrictEqual(seen, ["2/6", "3/6", "4/6"]);
  const cells = run.qnb.cells;
  assert.strictEqual(cells[2].source, "/ Parameters given to this run.\nn:5;");
  assert.deepStrictEqual(cells.map((c) => c.execution?.order), [undefined, 1, 2, 3, undefined, undefined]);
  assert.deepStrictEqual(cells[0].metadata, { [LIVE_KEY]: { a: { text: "v(a)" } } });
  assert.deepStrictEqual(cells[4].metadata, { keep: 1, [LIVE_KEY]: { n: { text: "v(n)" } } });
  assert.deepStrictEqual(cells[3].outputs, [{ items: [{ mime: "text/plain", text: "n*2" }] }]);
  // A Python cell is left as it was.
  assert.deepStrictEqual(cells[5], qnb.cells[4]);
  // The notebook given is not changed.
  assert.strictEqual(qnb.cells.length, 5);
});

// The editor's connection stays on the process a `/ @process` cell named,
// so the cells after it run there; a headless run does the same (#2150).
test("a headless run sends the cells after a / @process cell to that process, as the editor does (#2150)", async () => {
  const qnb = {
    cells: [
      { kind: "code", source: "a" },
      { kind: "code", source: "/ @process other\nb" },
      { kind: "code", source: "c" },
      { kind: "markdown", source: "{{q: c}}" },
      { kind: "code", source: "/ @process third" },
      { kind: "code", source: "d" },
    ],
  };
  const ex = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  await runNotebook(qnb, ex, SETTINGS);
  assert.deepStrictEqual(ex.sent, ["default", "other", "other", "third", "third"]);
  // The parameters given go where the parameters cell went.
  const params = { cells: [{ kind: "code", source: "/ @parameters\n/ @process other\nn:1" }, { kind: "code", source: "n" }] };
  const ex2 = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  await runNotebook(params, ex2, SETTINGS, { n: "2" });
  assert.deepStrictEqual(ex2.sent, ["other", "other", "other"]);
});

test("the guard reads a cell's live values' expressions with its source (#1088)", async () => {
  const markdown = ["Count {{q: count trade}}", "Gone {{q: delete from `trade}}", "Again {{q: count trade}}"];
  assert.deepStrictEqual(guardedText("/ just a note", markdown), ["/ just a note", { valued: "count trade" }, { valued: "delete from `trade" }]);
  assert.deepStrictEqual(writes(guardedText("/ just a note", markdown)), ["deletes from `trade in place"]);
  assert.deepStrictEqual(guardedText("1+1", []), ["1+1"]);
  // Each is read on its own: a cell ending the script or a `/` expression
  // does not hide what comes after it (#1442), and reads stay reads.
  assert.deepStrictEqual(writes(guardedText("count t\n\\", ["{{q: a:1}}"])), ["assigns a"]);
  assert.deepStrictEqual(writes(guardedText("count t", ["Rows {{q: /}} and {{q: a:1}}"])), ["assigns a"]);
  assert.deepStrictEqual(writes(guardedText("count t\n\\", ["Rows {{q: /}} and {{q: count t}}"])), []);
  // A headless run hands the executor, which guards it, the same text.
  const qnb = { cells: [{ kind: "code", source: "1" }, { kind: "markdown", source: markdown[1] }] };
  const ex = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  await runNotebook(qnb, ex, SETTINGS);
  assert.deepStrictEqual(ex.codes, [["1", { valued: "delete from `trade" }]]);
});

test("a headless run stops at the first cell that fails, and clears what the cells after it showed", async () => {
  const qnb = {
    cells: [
      { kind: "code", source: "1+`a" },
      { kind: "code", source: "2", execution: { order: 9 }, outputs: [{ items: [{ mime: "text/plain", text: "stale" }] }] },
    ],
  };
  const ex = fakeExecutor((cut) => (cut[0] === "1+`a" ? { ok: false, error: "type", trace: "" } : { ok: true, type: -7, text: ["2"] }));
  const run = await runNotebook(qnb, ex, SETTINGS);
  assert.deepStrictEqual(run.failed, { cell: 1, message: "'type" });
  assert.strictEqual(run.qnb.cells[0].execution.success, false);
  assert.strictEqual(JSON.parse(run.qnb.cells[0].outputs[0].items[0].text).message, "'type");
  assert.strictEqual(run.qnb.cells[1].outputs, undefined);
  assert.strictEqual(run.qnb.cells[1].execution, undefined);
  // A process that cannot be had fails its cell with why.
  const refused = await runNotebook({ cells: [{ kind: "code", source: "1" }] }, { on: async () => { throw new Error("no such process"); } }, SETTINGS);
  assert.deepStrictEqual(refused.failed, { cell: 1, message: "no such process" });
  await assert.rejects(runNotebook(qnb, ex, SETTINGS, { "1x": "1" }), /not a q name/);
  await assert.rejects(runNotebook(qnb, ex, SETTINGS, { x: "1\n2" }), /one line of q/);
});

test("a run is written as its target's extension says", () => {
  const qnb = { cells: [{ kind: "code", source: "1" }] };
  assert.match(writeAs(qnb, "/a/run.HTML", "n.qnb"), /^<!doctype html>/);
  assert.strictEqual(JSON.parse(writeAs(qnb, "run.ipynb", "n.qnb")).nbformat, 4);
  assert.strictEqual(parseQnb(writeAs(qnb, "run.qnb", "n.qnb")).cells.length, 1);
});

test("the command line reads its options, and refuses what it cannot run", () => {
  const o = parseArgs(["nb.qnb", "--process", "localhost:5001", "-p", "n", "5", "--param", "d", "2024.01.02", "--row-limit", "0", "--rows-from", "last"]);
  assert.strictEqual(o.output, "nb.out.qnb");
  assert.deepStrictEqual(o.params, { n: "5", d: "2024.01.02" });
  assert.strictEqual(o.rowLimit, 0);
  assert.strictEqual(o.rowsFrom, "last");
  assert.strictEqual(o.direct, false);
  assert.strictEqual(parseArgs(["nb.qnb", "--process", "h:1", "--direct"]).direct, true);
  assert.deepStrictEqual(parseArgs(["-h"]), { help: true });
  assert.match(parseArgs(["nb.qnb"]).error, /--process is needed/);
  assert.match(parseArgs(["--process", "h:1"]).error, /no notebook/);
  assert.match(parseArgs(["a.qnb", "b.qnb", "--process", "h:1"]).error, /one notebook at a time/);
  assert.match(parseArgs(["a.qnb", "--process", "h:1", "-p", "n"]).error, /needs a value/);
  assert.match(parseArgs(["a.qnb", "--process", "h:1", "--password", "x"]).error, /unknown option --password/);
  assert.match(parseArgs(["a.qnb", "--process", "h:1", "-p", "a b", "1"]).error, /not a q name/);
});

test("the command line names a process by host:port or by a listed label, and reads a password from the environment", () => {
  const listed = [{ label: "rdb", host: "h", port: 1, tags: ["prod"], user: "u" }];
  assert.strictEqual(cliProcess("rdb", listed), listed[0]);
  assert.deepStrictEqual(cliProcess("[::1]:5001", [], "me", true), { label: "[::1]:5001", host: "::1", port: 5001, tags: [], user: "me", tls: true });
  // --direct makes a host:port evaluate plain strings only; a listed
  // process keeps its own evaluation (#2473).
  assert.strictEqual(cliProcess("h:5001", [], undefined, false, true).evaluation, "direct");
  assert.strictEqual(cliProcess("h:5001", []).evaluation, undefined);
  assert.strictEqual(cliProcess("rdb", listed, undefined, false, true).evaluation, undefined);
  assert.match(cliProcess("rdb", []).error, /pass --processes/);
  assert.match(cliProcess("hdb", listed).error, /The labels are: rdb/);
  // A tunnelled or scripted process is refused, not dialled at its host (#1401).
  assert.match(cliProcess("t", [{ label: "t", host: "localhost", port: 5000, tags: [], ssh: "bastion" }]).error, /t needs an SSH tunnel \(ssh\), which qnbrun does not run/);
  assert.match(cliProcess("s", [{ label: "s", host: "h", port: 1, tags: [], initFile: "c.q" }]).error, /a connect script/);
  assert.strictEqual(passwordVariable("desk/rdb-1"), "QLINT_Q_PASSWORD_DESK_RDB_1");
  // By its address, a listed process keeps its tags, and so its production
  // check (#1450); another address, or another port, has none.
  const prod = [{ label: "prdb", host: "db1", port: 5000, tags: ["prod"] }, { label: "x", host: "DB1", port: 5000, tags: ["eu"] }];
  assert.deepStrictEqual(cliProcess("db1:5000", prod).tags, ["prod", "eu"]);
  assert.strictEqual(isProduction(cliProcess("db1:5000", prod)), true);
  assert.strictEqual(isProduction(cliProcess("db1:5001", prod)), false);
  assert.deepStrictEqual(cliProcess("db2:5000", prod).tags, []);
  // A process listed on the loopback is the same one by any loopback name (#1739).
  const local = [{ label: "lp", host: "localhost", port: 5000, tags: ["prod"] }, { label: "lq", host: "127.0.0.1", port: 5002, tags: ["prod"] }];
  for (const name of ["localhost:5000", "LOCALHOST:5000", "127.0.0.1:5000", "127.1.2.3:5000", "[::1]:5000"]) {
    assert.deepStrictEqual(cliProcess(name, local).tags, ["prod"], name);
  }
  assert.deepStrictEqual(cliProcess("localhost:5002", local).tags, ["prod"]);
  // Another host, or another port, is not it.
  assert.deepStrictEqual(cliProcess("127.0.0.1:5001", local).tags, []);
  assert.deepStrictEqual(cliProcess("10.0.0.1:5000", local).tags, []);
  assert.deepStrictEqual(cliProcess("localhostx:5000", local).tags, []);
});

// --- the variables view's data

test("the variables lambda's answer is read, nulls as nothing", () => {
  const { variables, total } = readVariables({ names: ["t", "f", "d", "sp"], types: [98, 100, -14, 98], counts: [3, 1, 1, 7], sizes: [138, null, 13, NaN], total: 4 });
  assert.strictEqual(total, 4);
  assert.deepStrictEqual(variables, [
    { name: "t", type: 98, count: 3, size: 138 },
    { name: "f", type: 100, count: 1 },
    { name: "d", type: -14, count: 1, size: 13 },
    { name: "sp", type: 98, count: 7 },
  ]);
  assert.deepStrictEqual(readVariables({ names: "a", types: 7, counts: 2, sizes: 30, total: 1 }).variables, [{ name: "a", type: 7, count: 2, size: 30 }]);
  assert.throws(() => readVariables("x"), /globals/);
  // A view was not evaluated: it has neither count nor size (#1865).
  assert.deepStrictEqual(readVariables({ names: ["t", "v"], types: [98, 100], counts: [3, null], sizes: [138, null], total: 2, views: [false, true] }).variables, [
    { name: "t", type: 98, count: 3, size: 138 },
    { name: "v", type: 100, view: true },
  ]);
  assert.match(VARS, /^\{\[lim\]/);
});

test("a variable is described by its kind, count and size", () => {
  assert.strictEqual(describeVariable({ name: "t", type: 98, count: 1500, size: 2048 }), "table · 1,500 rows · 2.0 KB");
  assert.strictEqual(describeVariable({ name: "x", type: 7, count: 3, size: 38 }), "long list · 3 items · 38 B");
  assert.strictEqual(describeVariable({ name: "s", type: -11, count: 1, size: 13 }), "symbol · 13 B");
  assert.strictEqual(describeVariable({ name: "b", type: 10, count: 3, size: 17 }), "string · 3 items · 17 B");
  assert.strictEqual(describeVariable({ name: "f", type: 100, count: 1 }), "function");
  assert.strictEqual(describeVariable({ name: "v", type: 100, view: true }), "view");
  assert.strictEqual(bytesText(5 * 1024 * 1024 * 1024), "5.0 GB");
});

test("package.json contributes the commands, the variables view and their menus", () => {
  const commands = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  for (const id of [NOTEBOOK.exportHtmlCommand, NOTEBOOK.exportIpynbCommand, NOTEBOOK.importIpynbCommand, NOTEBOOK.runWithParameters, NOTEBOOK.refreshVariables]) {
    assert.strictEqual(commands.get(id)?.category, "q-lint", id);
  }
  const view = pkg.contributes.views["q-lint"].find((v) => v.id === NOTEBOOK.variablesView);
  assert.strictEqual(view.when, "q-lint.notebookActive && config.q-lint.notebook.variables.enable");
  assert.ok(pkg.contributes.menus["view/title"].some((m) => m.command === NOTEBOOK.refreshVariables && m.when.startsWith(`view == ${NOTEBOOK.variablesView} && config.q-lint.notebook.variables.enable`)));
  assert.ok(pkg.contributes.menus["explorer/context"].some((m) => m.command === NOTEBOOK.importIpynbCommand && /ipynb/.test(m.when)));
  const toolbar = pkg.contributes.menus["notebook/toolbar"].filter((m) => m.when.startsWith("notebookType == q-lint-notebook")).map((m) => m.command);
  for (const id of [NOTEBOOK.exportHtmlCommand, NOTEBOOK.exportIpynbCommand, NOTEBOOK.runWithParameters]) {
    assert.ok(toolbar.includes(id), id);
  }
});

test("a line opening with a code span is text, not a fence (#1307)", () => {
  assert.strictEqual(markdownHtml("```a``` is q\n\nnext"), "<p><code>a</code> is q</p>\n<p>next</p>");
  assert.strictEqual(markdownHtml("```q\nx\n```"), "<pre><code>x</code></pre>");
});

test("a fence closes only on a bare run of its own character, at least as long (#1308)", () => {
  assert.strictEqual(markdownHtml("````\n```q\nx\n```\n````\nafter"), "<pre><code>```q\nx\n```</code></pre>\n<p>after</p>");
  assert.strictEqual(markdownHtml("```\n```q\n~~~\n```"), "<pre><code>```q\n~~~</code></pre>");
});

test("a backslash escapes any ASCII punctuation (#1310)", () => {
  assert.strictEqual(markdownHtml("\\<b\\> a\\|b \\& \\~ \\$ \\*x\\*"), "<p>&lt;b&gt; a|b &amp; ~ $ *x*</p>");
  assert.strictEqual(markdownHtml("a\\b"), "<p>a\\b</p>");
});

test("an ordered list keeps its start, and only a 1. or a bullet interrupts a paragraph (#1311)", () => {
  assert.strictEqual(markdownHtml("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.strictEqual(markdownHtml("0. z"), '<ol start="0"><li>z</li></ol>');
  assert.strictEqual(markdownHtml("it ran in\n2024. and then"), "<p>it ran in\n2024. and then</p>");
  assert.strictEqual(markdownHtml("text\n1. one"), "<p>text</p>\n<ol><li>one</li></ol>");
  assert.strictEqual(markdownHtml("text\n- one"), "<p>text</p>\n<ul><li>one</li></ul>");
});

test("a GFM table, as a result is written into a notebook, is a table (#1309)", () => {
  assert.strictEqual(
    markdownHtml("| a | n |\n| --- | ---: |\n| x\\|y | 1 |\n| &lt;b&gt; |\n\nafter"),
    '<table><thead><tr><th>a</th><th style="text-align:right">n</th></tr></thead>' +
      '<tbody><tr><td>x|y</td><td style="text-align:right">1</td></tr><tr><td>&lt;b&gt;</td><td style="text-align:right"></td></tr></tbody></table>\n<p>after</p>',
  );
  // Not a table: the delimiter row has a different count of cells.
  assert.strictEqual(markdownHtml("a | b | c\n--- | ---"), "<p>a | b | c\n--- | ---</p>");
  const { resultMarkdown } = require("../out/resultreport.js");
  const md = resultMarkdown({ at: 0, process: "dev", code: "t", decimals: 2, payload: { count: 1, keys: 0, names: ["s"], types: [11], cells: [["<a>"]], raw: [[]], rank: [[0]] } }).text;
  assert.match(markdownHtml(md), /<table><thead><tr><th>s<\/th><\/tr><\/thead><tbody><tr><td>&lt;a&gt;<\/td><\/tr><\/tbody><\/table>/);
});

test("a PyKX %%q cell with options imports as q, its options a comment (#1267)", () => {
  const cell = (source) => ({ cell_type: "code", metadata: {}, source, outputs: [] });
  const nb = { nbformat: 4, metadata: { kernelspec: { language: "python" } }, cells: [cell("%%q --port 5000\ntil 3"), cell("%%q  \n1"), cell("%%qx\n1")] };
  const qnb = fromIpynb(JSON.stringify(nb));
  assert.deepStrictEqual(qnb.cells.map((c) => [c.language, c.source]), [
    [undefined, "/ %%q --port 5000\ntil 3"],
    [undefined, "1"],
    ["python", "%%qx\n1"],
  ]);
});

test("a failed run drops the live values of the Markdown after the cells it did not run (#1544)", async () => {
  const stale = { [LIVE_KEY]: { y: { text: "999 (from last week)" } } };
  const qnb = {
    cells: [
      { kind: "code", source: "x:1" },
      { kind: "code", source: "'boom" },
      { kind: "markdown", source: "after the failure {{q: y}}", metadata: { keep: 1, ...stale } },
      { kind: "code", source: "y:2" },
      { kind: "markdown", source: "y is {{q: y}}", metadata: stale },
    ],
  };
  const ex = fakeExecutor((cut) => (cut[0] === "'boom" ? { ok: false, error: "boom", trace: "" } : { ok: true, type: -7, text: ["1"] }));
  const run = await runNotebook(qnb, ex, SETTINGS);
  assert.deepStrictEqual(run.failed, { cell: 2, message: "'boom" });
  assert.deepStrictEqual(run.qnb.cells[2].metadata, { keep: 1 });
  assert.deepStrictEqual(run.qnb.cells[4].metadata, {});
  assert.doesNotMatch(toHtml(run.qnb, "n"), /from last week/);
});

// Values not read are not this run's: they go, as a failed cell's do (#2151).
test("a run with live values off drops the values an earlier run kept, and writes none (#2151)", async () => {
  const stale = { [LIVE_KEY]: { total: { text: "50" } } };
  const qnb = {
    cells: [
      { kind: "markdown", source: "Top {{q: total}}", metadata: stale },
      { kind: "code", source: "total:10*n" },
      { kind: "markdown", source: "Total is {{q: total}}", metadata: { keep: 1, ...stale } },
    ],
  };
  const ex = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  const run = await runNotebook(qnb, ex, SETTINGS, { n: "7" }, { liveValues: false });
  assert.strictEqual(run.failed, undefined);
  assert.deepStrictEqual(ex.codes.flat().filter((c) => c === "total"), []);
  // The parameters' cell is the first.
  assert.deepStrictEqual(run.qnb.cells[1].metadata, {});
  assert.deepStrictEqual(run.qnb.cells[3].metadata, { keep: 1 });
  assert.doesNotMatch(toHtml(run.qnb, "n"), />50</);
});

test("parameters given to a notebook with no parameters cell do not read the Markdown above the first code cell (#2152)", async () => {
  const qnb = { cells: [{ kind: "markdown", source: "Trades: {{q: count topt}}" }, { kind: "code", source: "topt:til lim" }, { kind: "markdown", source: "{{q: lim}}" }] };
  const ex = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  const run = await runNotebook(qnb, ex, SETTINGS, { lim: "7" });
  // The parameters' cell sends its own statements only; the first code
  // cell reads the Markdown above it and below it.
  assert.deepStrictEqual(ex.codes, [["/ Parameters given to this run.\nlim:7;"], ["topt:til lim", { valued: "count topt" }, { valued: "lim" }]]);
  assert.deepStrictEqual(run.qnb.cells[1].metadata, { [LIVE_KEY]: { "count topt": { text: "v(count topt)" } } });
  // With a parameters cell, the Markdown after it is read after the values given.
  const withCell = { cells: [{ kind: "code", source: "/ @parameters\nlim:5" }, { kind: "markdown", source: "{{q: lim}}" }] };
  const ex2 = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  await runNotebook(withCell, ex2, SETTINGS, { lim: "7" });
  assert.deepStrictEqual(ex2.codes, [["/ @parameters\nlim:5"], ["/ Parameters given to this run.\nlim:7;", { valued: "lim" }]]);
});

test("a JSON output that is an array or a string comes back from Jupyter as the same JSON (#1545)", () => {
  for (const text of ["[1,2]", '"abc"', '{"a":[1]}', "3"]) {
    const qnb = { cells: [{ kind: "code", source: "1", outputs: [{ items: [{ mime: "application/json", text }] }] }] };
    assert.strictEqual(fromIpynb(toIpynb(qnb)).cells[0].outputs[0].items[0].text, text);
  }
});

test("a Jupyter notebook keeps its metadata, kernel and cell ids through import and export (#1548)", () => {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { author: "me", kernelspec: { language: "python", name: "python3", display_name: "Python 3" }, language_info: { name: "python" } },
    cells: [
      { id: "m1", cell_type: "markdown", metadata: {}, source: "# T" },
      { id: "c1", cell_type: "code", execution_count: null, metadata: {}, source: "import pykx", outputs: [] },
      { id: "c2", cell_type: "code", execution_count: null, metadata: {}, source: "%%q --port 5000\ntil 3", outputs: [] },
      { id: "c3", cell_type: "code", execution_count: null, metadata: {}, source: "%%q\n1+1", outputs: [] },
    ],
  };
  const qnb = fromIpynb(JSON.stringify(nb));
  assert.strictEqual(qnb.metadata.author, "me");
  assert.strictEqual(qnb.cells[1].extra.id, "c1");
  const back = JSON.parse(toIpynb(qnb));
  assert.deepStrictEqual(back.metadata, nb.metadata);
  assert.strictEqual(back.nbformat_minor, 5);
  assert.deepStrictEqual(back.cells.map((c) => c.id), ["m1", "c1", "c2", "c3"]);
  // On a Python kernel a q cell goes back with its %%q magic.
  assert.deepStrictEqual(back.cells.map((c) => c.source.join("")), ["# T", "import pykx", "%%q --port 5000\ntil 3", "%%q\n1+1"]);
  // A q notebook's own kernel is not kept as metadata of its .qnb.
  const q = { cells: [{ kind: "code", source: "1" }] };
  assert.strictEqual(fromIpynb(toIpynb(q)).metadata, undefined);
  assert.strictEqual(JSON.parse(toIpynb(q)).metadata.kernelspec.name, "qpk");
});

test("an HTML export nests ***text*** as CommonMark does (#1550)", () => {
  assert.strictEqual(markdownHtml("***both*** and ___too___"), "<p><em><strong>both</strong></em> and <em><strong>too</strong></em></p>");
  assert.strictEqual(markdownHtml("**a *b* c**"), "<p><strong>a <em>b</em> c</strong></p>");
});

test("an HTML export reads a setext heading, under a paragraph only (#1551)", () => {
  assert.strictEqual(markdownHtml("Sub\n---"), "<h2>Sub</h2>");
  assert.strictEqual(markdownHtml("Title\n====="), "<h1>Title</h1>");
  assert.strictEqual(markdownHtml("a *b*\nc\n  ==  "), "<h1>a <em>b</em>\nc</h1>");
  assert.strictEqual(markdownHtml("text\n\n---"), "<p>text</p>\n<hr>");
  assert.strictEqual(markdownHtml("- item\n---"), "<ul><li>item</li></ul>\n<hr>");
});

test("an HTML export keeps a named entity, which the page shows as its character (#1552)", () => {
  assert.strictEqual(markdownHtml("a&nbsp;b &copy; 2024 &lt;x&gt; &amp;"), "<p>a&nbsp;b &copy; 2024 &lt;x&gt; &amp;</p>");
  // Not an entity: escaped.
  assert.strictEqual(markdownHtml("a & b &x y; &<b>;"), "<p>a &amp; b &amp;x y; &amp;&lt;b&gt;;</p>");
});

test("an HTML export shows an indented code block as code, as the cell and live values read it (#1553)", () => {
  assert.strictEqual(markdownHtml("    indented code"), "<pre><code>indented code</code></pre>");
  assert.strictEqual(markdownHtml("text\n\n    f:{x+1}\n\n      g:2\n\nafter"), "<p>text</p>\n<pre><code>f:{x+1}\n\n  g:2</code></pre>\n<p>after</p>");
  assert.strictEqual(markdownHtml("# T\n\tt:1 <b>"), "<h1>T</h1>\n<pre><code>t:1 &lt;b&gt;</code></pre>");
  // Under a paragraph line or a list item it is not code.
  assert.strictEqual(markdownHtml("text\n    more"), "<p>text\nmore</p>");
  assert.strictEqual(markdownHtml("- a\n    b"), "<ul><li>a\nb</li></ul>");
});

test("an HTML export keeps balanced parentheses in a link's URL (#1554)", () => {
  assert.strictEqual(
    markdownHtml("[Q](https://en.wikipedia.org/wiki/Q_(programming_language)) now (see [a](https://x.io/a))"),
    '<p><a href="https://en.wikipedia.org/wiki/Q_(programming_language)">Q</a> now (see <a href="https://x.io/a">a</a>)</p>',
  );
});

test("an HTML export shows a data: image as the image, and another image as a link or its alt text (#1555)", () => {
  assert.strictEqual(markdownHtml("![chart](data:image/png;base64,iVBORw0KGgo+/=)"), '<p><img alt="chart" src="data:image/png;base64,iVBORw0KGgo+/="></p>');
  assert.strictEqual(markdownHtml('![a "b" & c](data:image/gif;base64,R0lG)'), '<p><img alt="a &quot;b&quot; &amp; c" src="data:image/gif;base64,R0lG"></p>');
  assert.strictEqual(markdownHtml("![logo](https://x.io/l.png)"), '<p><a href="https://x.io/l.png">logo</a></p>');
  assert.strictEqual(markdownHtml("![svg](data:image/svg+xml;base64,PHN2Zz4=)"), "<p>svg</p>");
});

test("an HTML export leaves a double underscore inside a word as it is (#1556)", () => {
  assert.strictEqual(markdownHtml("call my__private__helper now"), "<p>call my__private__helper now</p>");
  assert.strictEqual(markdownHtml("__a__b and a___b___c"), "<p>__a__b and a___b___c</p>");
  assert.strictEqual(markdownHtml("__bold__ and **x**y"), "<p><strong>bold</strong> and <strong>x</strong>y</p>");
});

test("a live value in an HTML block or inside a tag is text, as the renderer shows it (#1557)", () => {
  assert.deepStrictEqual(liveExpressions("<div>\n{{q: inHtml}}\n</div>\n\nAfter {{q: a}}"), ["a"]);
  assert.deepStrictEqual(liveExpressions('<span title="{{q: inAttr}}">x</span> and <b>{{q: b}}</b>'), ["b"]);
  assert.deepStrictEqual(liveExpressions("<pre>\n{{q: p}}\n\n{{q: q}}\n</pre>\n{{q: c}}"), ["c"]);
  // A tag inside the expression is the expression's; a paragraph's line is not an HTML block.
  assert.deepStrictEqual(liveExpressions("{{q: a<b>c}}\ntext\n<x-y>\n{{q: d}}"), ["a<b>c", "d"]);
  assert.strictEqual(markdownHtml('<span title="{{q: x}}">y</span>'), "<p>&lt;span title=&quot;{{q: x}}&quot;&gt;y&lt;/span&gt;</p>");
});

test("an indented block after a heading or a rule is code, and holds no live value (#1558)", () => {
  assert.deepStrictEqual(liveExpressions("# Title\n    {{q: afterHeading}}"), []);
  assert.deepStrictEqual(liveExpressions("---\n    {{q: afterRule}}"), []);
  assert.deepStrictEqual(liveExpressions("Title\n===\n    {{q: afterSetext}}"), []);
  assert.deepStrictEqual(liveExpressions("Para\n    {{q: lazy}}"), ["lazy"]);
  // A lone == or -- is a paragraph's text, not an underline (#1722).
  assert.deepStrictEqual(liveExpressions("==\n    {{q: 1+1}}"), ["1+1"]);
  assert.deepStrictEqual(liveExpressions("intro\n\n--\n    {{q: 2+2}}"), ["2+2"]);
  assert.deepStrictEqual(liveExpressions("Title\n--\n    {{q: afterUnderline}}"), []);
  assert.strictEqual(markdownHtml("---\n    x"), "<hr>\n<pre><code>x</code></pre>");
});

test("a live value of a big list or table is written from its first items only (#1559)", () => {
  assert.match(LIVE, /\}\[200;\$\[\(type v\) within 0 99h;\{@\[\{.*\}x;y;y\]\}\[v\] @\[200 sublist;v;v\];v\]\]/);
  // An attribute the cut drops is put back (#1718).
  assert.match(LIVE, /\(attr x\)#y/);
});

test("a variable's size takes the next unit when it rounds up to 1024 (#1495)", () => {
  assert.strictEqual(bytesText(512), "512 B");
  assert.strictEqual(bytesText(1023), "1023 B");
  assert.strictEqual(bytesText(1536), "1.5 KB");
  assert.strictEqual(bytesText(10239), "10 KB");
  assert.strictEqual(bytesText(1048575), "1.0 MB");
  assert.strictEqual(bytesText(1073741823), "1.0 GB");
  assert.strictEqual(bytesText(5 * 1024 * 1024 * 1024 * 1024 * 1024), "5120 TB");
});

test("QLINT_Q_PASSWORD is --process's alone, never sent to another listed process (#1547)", () => {
  const env = { QLINT_Q_PASSWORD: "dev", QLINT_Q_PASSWORD_RDB: "r" };
  const target = (label, user = "u") => ({ label, host: "h", port: 1, tags: [], user });
  assert.strictEqual(passwordOf(target("dev:5000"), env, true), "dev");
  assert.strictEqual(passwordOf(target("prod_rdb"), env, false), "");
  assert.strictEqual(passwordOf(target("rdb"), env, false), "r");
  assert.strictEqual(passwordOf(target("rdb", ""), env, true), undefined);
});

// rdb-1, rdb_1, rdb.1 and "RDB 1" all read QLINT_Q_PASSWORD_RDB_1: one
// password was sent to every one a notebook named (#1833).
test("a password variable two listed processes would share is refused, not sent to both", () => {
  const p = (label, user = "u") => ({ label, host: label, port: 1, tags: [], user });
  const listed = [p("rdb-1"), p("rdb_1"), p("Prod"), p("prod", ""), p("gw")];
  const env = { QLINT_Q_PASSWORD_RDB_1: "one", QLINT_Q_PASSWORD_PROD: "pr", QLINT_Q_PASSWORD_GW: "g" };
  assert.throws(() => passwordOf(listed[0], env, false, listed), /^Error: rdb-1 and rdb_1 both read their password from QLINT_Q_PASSWORD_RDB_1: relabel one/);
  assert.throws(() => passwordOf(listed[1], env, false, listed), /rdb_1 and rdb-1/);
  // A process with no user is asked for no password, so shares nothing.
  assert.strictEqual(passwordOf(listed[2], env, false, listed), "pr");
  assert.strictEqual(passwordOf(listed[4], env, false, listed), "g");
  // HOST:PORT given on the command line is checked against the list too.
  assert.throws(() => passwordOf(p("rdb:1"), env, true, [p("rdb_1")]), /rdb:1 and rdb_1/);
});

test("an HTML export writes a link's URL as it was written: an entity, an escape or a {{q:}} in it is no placeholder (#1942)", () => {
  assert.strictEqual(markdownHtml("[x](https://host/?a=1&amp;b=2)"), '<p><a href="https://host/?a=1&amp;b=2">x</a></p>');
  assert.strictEqual(markdownHtml("[x](https://host/a\\_b\\(1\\)) and *y*"), '<p><a href="https://host/a_b(1)">x</a> and <em>y</em></p>');
  assert.strictEqual(markdownHtml("[open](https://host/{{q:id}}/`a`)"), '<p><a href="https://host/{{q:id}}/`a`">open</a></p>');
  assert.strictEqual(markdownHtml("[x](https://host/&copy;&#x41;)"), '<p><a href="https://host/&amp;copy;A">x</a></p>');
  assert.strictEqual(markdownHtml("![logo](https://x.io/l.png?a=1&amp;b=2)"), '<p><a href="https://x.io/l.png?a=1&amp;b=2">logo</a></p>');
  // No placeholder, and so no NUL, is left in any of them.
  for (const source of ["[x](https://host/?a=1&amp;b=2)", "[open](https://host/{{q: id}})", "[x](https://h/<b>)", "[x](\\https://h)"]) {
    assert.doesNotMatch(markdownHtml(source, { id: { text: "7" } }), /\u0000/, source);
  }
  // What an entity or an escape spells is still checked and escaped: no
  // script URL, and no quote that would end the attribute.
  assert.strictEqual(markdownHtml("[x](&#106;avascript:alert(1))"), "<p>[x](javascript:alert(1))</p>");
  assert.strictEqual(markdownHtml("[x](java\\script:alert(1))"), "<p>[x](java\\script:alert(1))</p>");
  assert.strictEqual(markdownHtml("[x](https://h/&quot;onmouseover=&quot;a&lt;b)"), '<p><a href="https://h/&quot;onmouseover=&quot;a&lt;b">x</a></p>');
  // A destination with a blank in it is no link, as CommonMark reads it.
  assert.strictEqual(markdownHtml("[open](https://host/{{q: id}})"), "<p>[open](https://host/<code>{{q: id}}</code>)</p>");
});

test("an HTML export nests a list written under an item, as the notebook shows it (#1943)", () => {
  assert.strictEqual(markdownHtml("- a\n  - b\n- c"), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  assert.strictEqual(markdownHtml("- a\n    - b\n- c"), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  assert.strictEqual(markdownHtml("1. a\n   - b\n2. c"), "<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>");
  // Deeper, a numbered one under a bullet, and an item's own next line.
  assert.strictEqual(markdownHtml("- a\n  - b\n    - c\n  - d\n- e"), "<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>");
  assert.strictEqual(markdownHtml("* a\n  3. b\n  4. c\n     more"), '<ul><li>a<ol start="3"><li>b</li><li>c\nmore</li></ol></li></ul>');
  assert.strictEqual(markdownHtml("- a\n\t- b"), "<ul><li>a<ul><li>b</li></ul></li></ul>");
  // Under the item's text, not under its marker: a sibling, as before.
  assert.strictEqual(markdownHtml("- a\n - b"), "<ul><li>a</li><li>b</li></ul>");
  assert.strictEqual(markdownHtml("- a\n  b\n  c"), "<ul><li>a\nb\nc</li></ul>");
  // What is nested is text still: escaped, and its live value read.
  assert.strictEqual(
    markdownHtml("- a\n  - <b>x</b> {{q: n}} [l](javascript:alert(1))", { n: { text: "<7>" } }),
    '<ul><li>a<ul><li>&lt;b&gt;x&lt;/b&gt; <span class="live" title="q: n">&lt;7&gt;</span> [l](javascript:alert(1))</li></ul></li></ul>',
  );
});

test("an HTML export keeps a link's title, as the tip the notebook shows (#1944)", () => {
  assert.strictEqual(markdownHtml('[text](https://x.com "title")'), '<p><a href="https://x.com" title="title">text</a></p>');
  assert.strictEqual(markdownHtml("[text](https://x.com 'the title') and [b](https://y.io (in brackets))"), '<p><a href="https://x.com" title="the title">text</a> and <a href="https://y.io" title="in brackets">b</a></p>');
  assert.strictEqual(markdownHtml('![logo](https://x.io/l.png "the logo")'), '<p><a href="https://x.io/l.png" title="the logo">logo</a></p>');
  assert.strictEqual(markdownHtml('![c](data:image/png;base64,AAAA "a chart")'), '<p><img alt="c" src="data:image/png;base64,AAAA" title="a chart"></p>');
  // A title is text: nothing in it is markup, a value or the attribute's end.
  assert.strictEqual(
    markdownHtml('[t](https://x.com "a <b> &amp; \\"q\\" `c` *e* {{q: n}}")', { n: { text: "7" } }),
    '<p><a href="https://x.com" title="a &lt;b&gt; &amp; &quot;q&quot; `c` *e* {{q: n}}">t</a></p>',
  );
  assert.strictEqual(markdownHtml("[t](https://x.com 'a\" onmouseover=\"b')"), '<p><a href="https://x.com" title="a&quot; onmouseover=&quot;b">t</a></p>');
  // A title makes no link of a target that is none.
  assert.strictEqual(markdownHtml('[x](javascript:alert(1) "t")'), "<p>[x](javascript:alert(1) &quot;t&quot;)</p>");
  assert.strictEqual(markdownHtml('[x](https://x.com "t" more)'), "<p>[x](https://x.com &quot;t&quot; more)</p>");
});

test("an HTML export breaks a paragraph's line only where the notebook does: after two spaces or a backslash (#1945)", () => {
  // A cell wrapped at a column is one paragraph, a newline in it a space.
  assert.strictEqual(markdownHtml("line one\nline two\nline three"), "<p>line one\nline two\nline three</p>");
  assert.strictEqual(markdownHtml("line one  \nline two"), "<p>line one<br>\nline two</p>");
  assert.strictEqual(markdownHtml("line one\\\nline two   \nline three"), "<p>line one<br>\nline two<br>\nline three</p>");
  // One space is none, an escaped backslash is a backslash, and a
  // paragraph's last line has nothing to break before.
  assert.strictEqual(markdownHtml("a \nb"), "<p>a\nb</p>");
  assert.strictEqual(markdownHtml("a\\\\\nb"), "<p>a\\\nb</p>");
  assert.strictEqual(markdownHtml("end  "), "<p>end</p>");
  assert.strictEqual(markdownHtml("end\\\n\nnext"), "<p>end\\</p>\n<p>next</p>");
  assert.strictEqual(markdownHtml("Title  \n==="), "<h1>Title</h1>");
  assert.strictEqual(markdownHtml("a <b>  \n*c*"), "<p>a &lt;b&gt;<br>\n<em>c</em></p>");
});

// The export reads a paragraph, a list item and a quote whole, as the run
// does: a value over two lines is found, under the key it was kept by (#2149).
test("an HTML export shows a {{q: }} written over two lines, by the key the run kept it under (#2149)", () => {
  for (const [source, html] of [
    ["Para {{q: 1+\n 2}} end", '<p>Para <span class="live" title="q: 1+\n 2">3</span> end</p>'],
    ["- item {{q: 1+\n  2}} x", '<ul><li>item <span class="live" title="q: 1+\n 2">3</span> x</li></ul>'],
    ["> quote {{q: 1+\n> 2}}", '<blockquote><p>quote <span class="live" title="q: 1+\n 2">3</span></p></blockquote>'],
    ["# x\nSub {{q: 1+\n2}}\n---", '<h1>x</h1>\n<h2>Sub <span class="live" title="q: 1+\n 2">3</span></h2>'],
  ]) {
    assert.deepStrictEqual(liveExpressions(source), ["1+\n 2"], source);
    assert.strictEqual(markdownHtml(source, { "1+\n 2": { text: "3" } }), html, source);
  }
  // A hard break beside it is still one.
  assert.strictEqual(markdownHtml("a  \nb {{q: 1+\n 2}}", { "1+\n 2": { text: "3" } }), '<p>a<br>\nb <span class="live" title="q: 1+\n 2">3</span></p>');
});

/// A Python notebook as Jupyter saves one: a figure shown, a value with
/// what was printed after it, a `%%q` cell, and a cell not run.
const PYTHON_NOTEBOOK = {
  cells: [
    { cell_type: "code", execution_count: 1, metadata: {}, outputs: [{ output_type: "display_data", data: { "image/png": "AAAA", "text/plain": ["<Figure>"] }, metadata: {} }], source: ["import matplotlib\n", "plot()"] },
    {
      cell_type: "code",
      execution_count: 2,
      metadata: {},
      outputs: [
        { output_type: "execute_result", execution_count: 2, data: { "text/plain": ["1"] }, metadata: {} },
        { output_type: "stream", name: "stdout", text: ["x\n"] },
      ],
      source: ["1"],
    },
    { cell_type: "code", execution_count: 3, metadata: {}, outputs: [{ output_type: "display_data", data: { "text/plain": ["a"] }, metadata: {} }, { output_type: "display_data", data: { "text/plain": ["b"] }, metadata: {} }], source: ["%%q\n", "show 1"] },
    { cell_type: "code", execution_count: null, metadata: { collapsed: true }, outputs: [], source: [] },
    { cell_type: "markdown", metadata: {}, source: ["# T"] },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python", version: "3.11" } },
  nbformat: 4,
  nbformat_minor: 4,
};

test("a Jupyter notebook imported and exported keeps each output's type: a figure is no Out[n] value (#1946)", () => {
  const back = JSON.parse(toIpynb(fromIpynb(JSON.stringify(PYTHON_NOTEBOOK))));
  const types = (notebook) => notebook.cells.map((c) => (c.outputs ?? []).map((o) => o.output_type));
  assert.deepStrictEqual(types(back), [["display_data"], ["execute_result", "stream"], ["display_data", "display_data"], [], []]);
  assert.deepStrictEqual(back.cells.map((c) => c.outputs), PYTHON_NOTEBOOK.cells.map((c) => c.outputs));
  // The type is the output's own through a save of the .qnb as well.
  const saved = JSON.parse(toIpynb(parseQnb(serializeQnb(fromIpynb(JSON.stringify(PYTHON_NOTEBOOK))))));
  assert.deepStrictEqual(types(saved), types(PYTHON_NOTEBOOK));
  // An output made here has none: the last one of a cell that ran is its value.
  const made = JSON.parse(toIpynb({ cells: [{ kind: "code", source: "1", execution: { order: 4 }, outputs: [{ items: [{ mime: "text/plain", text: "a" }] }, { items: [{ mime: "text/plain", text: "1" }] }] }] }));
  assert.deepStrictEqual(made.cells[0].outputs.map((o) => [o.output_type, o.execution_count]), [["display_data", undefined], ["execute_result", 4]]);
  // A value's number is its cell's, and nothing but the two types is taken from the file.
  const odd = { cells: [{ kind: "code", source: "1", outputs: [{ items: [{ mime: "text/plain", text: "1" }], extra: { output_type: "execute_result" } }, { items: [{ mime: "text/plain", text: "2" }], extra: { output_type: "<script>" } }] }] };
  assert.deepStrictEqual(JSON.parse(toIpynb(odd)).cells[0].outputs.map((o) => [o.output_type, o.execution_count]), [["execute_result", null], ["display_data", undefined]]);
});

test("a Python notebook imported and exported is the notebook it was: no cell is tagged with the notebook's own language (#1947)", () => {
  const back = JSON.parse(toIpynb(fromIpynb(JSON.stringify(PYTHON_NOTEBOOK))));
  assert.deepStrictEqual(back.cells.map((c) => c.metadata), PYTHON_NOTEBOOK.cells.map((c) => c.metadata));
  // And so are its cells' outputs and their types: all of it.
  assert.deepStrictEqual(back, PYTHON_NOTEBOOK);
  // A cell in another language than the notebook's is tagged, as VS Code tags one.
  const mixed = { ...PYTHON_NOTEBOOK, cells: [{ cell_type: "code", execution_count: null, metadata: { vscode: { languageId: "sql" } }, outputs: [], source: ["select 1"] }, PYTHON_NOTEBOOK.cells[3]] };
  assert.deepStrictEqual(JSON.parse(toIpynb(fromIpynb(JSON.stringify(mixed)))), mixed);
  const q = JSON.parse(toIpynb({ cells: [{ kind: "code", source: "print(1)", language: "python" }, { kind: "code", source: "1+1" }] }));
  assert.deepStrictEqual(q.cells.map((c) => c.metadata), [{ vscode: { languageId: "python" } }, {}]);
  // With only a kernelspec's language to go by, too.
  const spec = { ...PYTHON_NOTEBOOK, metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } } };
  assert.deepStrictEqual(JSON.parse(toIpynb(fromIpynb(JSON.stringify(spec)))), spec);
});

test("a Python notebook that names its language only in language_info goes back as Python, not as q (#2381)", () => {
  const nb = { cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["print(1)"] }, { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["%%q\n", "til 3"] }], metadata: { language_info: { name: "python" } }, nbformat: 4, nbformat_minor: 4 };
  const back = JSON.parse(toIpynb(fromIpynb(JSON.stringify(nb))));
  assert.deepStrictEqual(back.metadata, { language_info: { name: "python" } });
  assert.deepStrictEqual(fromIpynb(JSON.stringify(back)).cells.map((c) => c.language ?? "q"), ["python", "q"]);
  // A notebook that names none is written as q's.
  assert.strictEqual(JSON.parse(toIpynb({ cells: [] })).metadata.language_info.name, "q");
});

test("a Jupyter kernelspec with no language is read by its name: python3's cells are Python, qpk's q (#2382)", () => {
  const nb = (kernelspec) => JSON.stringify({ nbformat: 4, metadata: { kernelspec }, cells: [{ cell_type: "code", source: ["import pandas as pd\n", "x = 1"], metadata: {}, outputs: [] }] });
  assert.strictEqual(fromIpynb(nb({ name: "python3", display_name: "Python 3 (ipykernel)" })).cells[0].language, "python");
  assert.strictEqual(fromIpynb(nb({ name: "ir", display_name: "R" })).cells[0].language, "r");
  assert.strictEqual(fromIpynb(nb({ name: "julia-1.10", display_name: "Julia 1.10" })).cells[0].language, "julia");
  assert.strictEqual(fromIpynb(nb({ name: "qpk", display_name: "q (kdb+)" })).cells[0].language, undefined);
  assert.strictEqual(fromIpynb(nb({ display_name: "?" })).cells[0].language, undefined);
  // And back out, the notebook's own kernel kept, its cells untagged.
  const back = JSON.parse(toIpynb(fromIpynb(nb({ name: "python3", display_name: "Python 3 (ipykernel)" }))));
  assert.deepStrictEqual([back.metadata.kernelspec.name, back.cells[0].metadata, back.cells[0].source], ["python3", {}, ["import pandas as pd\n", "x = 1"]]);
});

test("a live value's expression is read as LIVE values it, whole: a / line in it hides nothing (#2033)", () => {
  const code = guardedText("1+1", ["Count: {{q: (1;\n/\nd6:9)}} rows"]);
  assert.deepStrictEqual(writes(code), ["assigns d6"]);
});

// The first cell to open a connection decided its password: one naming
// `/ @process rdb` opened rdb without QLINT_Q_PASSWORD, though --process
// rdb gives it that, and every cell after reused it (#2135).
test("a cell naming --process's own label connects as --process does (#2135)", async (t) => {
  const net = require("node:net");
  const os = require("node:os");
  const { main } = require("../out/qnbrun.js");
  const logins = [];
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
    s.once("data", (d) => {
      logins.push(d.subarray(0, d.length - 2).toString("utf8"));
      s.write(Buffer.from([3]));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-qnbrun-"));
  t.after(() => (server.close(), fs.rmSync(dir, { recursive: true, force: true })));
  const list = path.join(dir, "list.json");
  fs.writeFileSync(list, JSON.stringify({ processes: [{ label: "rdb", host: "127.0.0.1", port: server.address().port, user: "bob", tags: [] }] }));
  for (const [name, first] of [["named", ["/ @process rdb", "1+1"]], ["bare", ["1+1"]]]) {
    const nb = path.join(dir, `${name}.qnb`);
    fs.writeFileSync(nb, JSON.stringify({ qnb: 1, cells: [{ kind: "code", source: first }, { kind: "code", source: ["2+2"] }] }));
    // The fake answers no query: the run fails at its first cell, after the handshake.
    const run = main([nb, "--process", "rdb", "--processes", list, "-o", path.join(dir, `${name}.out.qnb`)], { QLINT_Q_PASSWORD: "not-a-real-secret" }, () => {});
    await new Promise((r) => setTimeout(r, 300));
    for (const s of sockets) s.destroy();
    assert.strictEqual(await run, 1);
  }
  assert.deepStrictEqual(logins, ["bob:not-a-real-secret", "bob:not-a-real-secret"]);
});
