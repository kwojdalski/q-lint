// Toggle Parameter Cache (#892): finding the lambda at the cursor and its
// parameters, the statement inserted, removing exactly it, and refusing what
// q-lint did not insert. Run after `tsc`; nothing here needs an editor or a
// q process (paramcache_q.test.js runs the statements on a real one).
const test = require("node:test");
const assert = require("node:assert");
const { cacheStatement, cachedLambdas, cachedText, codeMask, lambdaAt, lambdas, newId, parameters, toggleAt } = require("../out/paramcache.js");

/// A fixed "random" so the id is known: 0x1a2b3c.
const fixed = () => 0x1a2b3c / 0x1000000;
const ID = "p1a2b3c";

/// The parameters of the lambda at the `|` in `marked`.
function paramsAt(marked) {
  const offset = marked.indexOf("|");
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  const lambda = lambdaAt(text, offset);
  return lambda === undefined ? undefined : parameters(text, lambda);
}

/// Toggle at the `|` in `marked`, and the text after it.
function toggled(marked) {
  const offset = marked.indexOf("|");
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  return { text, offset, ...apply(text, offset) };
}

function apply(text, offset) {
  const t = toggleAt(text, offset, fixed);
  if (t.kind === "insert") {
    return { toggle: t, after: text.slice(0, t.offset) + t.text + text.slice(t.offset) };
  }
  if (t.kind === "remove") {
    return { toggle: t, after: text.slice(0, t.start) + text.slice(t.end) };
  }
  return { toggle: t, after: text };
}

test("the statement: one parameter is set as an atom name, several each", () => {
  assert.strictEqual(cacheStatement(ID, ["a"]), "@[`.qlint.cache.p1a2b3c set;a;::];@[`a set;a;::];");
  assert.strictEqual(cacheStatement(ID, ["a", "b"]), "@[`.qlint.cache.p1a2b3c set;(a;b);::];@[`a`b set';(a;b);::];");
  assert.strictEqual(cacheStatement(ID, ["x", "y", "z"]), "@[`.qlint.cache.p1a2b3c set;(x;y;z);::];@[`x`y`z set';(x;y;z);::];");
});

test("an id is p and six hex digits, never one the file already uses", () => {
  assert.strictEqual(newId([], fixed), ID);
  assert.strictEqual(newId([ID, "p1a2b3d"], fixed), "p1a2b3e");
  assert.strictEqual(newId(["pffffff"], () => 0xffffff / 0x1000000), "p000000");
  assert.match(newId([]), /^p[0-9a-f]{6}$/);
});

test("explicit parameters are the [...] list, spaces and all", () => {
  assert.deepStrictEqual(paramsAt("f:{[a;b] a|+b}"), ["a", "b"]);
  assert.deepStrictEqual(paramsAt("f:{[ a ; bb ]\n  a+bb|}"), ["a", "bb"]);
  // q takes a list after spaces too.
  assert.deepStrictEqual(paramsAt("f:{ [n] n|}"), ["n"]);
  assert.deepStrictEqual(paramsAt("f:{[] 4|2}"), []);
  // An explicit list wins over the x it reads.
  assert.deepStrictEqual(paramsAt("f:{[a] a+|x}"), ["a"]);
});

test("a typed or pattern list binds what q binds, and the body starts after it (#2332)", () => {
  const { lambdas, parameters, patternNames } = require("../out/paramcache.js");
  const at = (text) => {
    const [l] = lambdas(text);
    return [parameters(text, l), text.slice(l.bodyStart)];
  };
  assert.deepStrictEqual(at("f:{[x:`j;y:`j] x+y}"), [["x", "y"], " x+y}"]);
  assert.deepStrictEqual(at("h:{[(x;y)] x+y}"), [["x", "y"], " x+y}"]);
  assert.deepStrictEqual(at("g:{[a:`j;b] a+b}"), [["a", "b"], " a+b}"]);
  assert.deepStrictEqual(at("k:{[([k:v:abs]);c] v+c}"), [["v", "c"], " v+c}"]);
  assert.deepStrictEqual(at("m:{ [k!v] (k;v)}"), [["k", "v"], " (k;v)}"]);
  assert.deepStrictEqual(patternNames("([]a;b:c)"), ["a", "c"]);
  assert.deepStrictEqual(patternNames("`a`b!(p;q:neg)"), ["p", "q"]);
  assert.deepStrictEqual(patternNames("1"), []);
});

test("implicit parameters are x, y and z up to the highest the body reads", () => {
  assert.deepStrictEqual(paramsAt("{x|+1}"), ["x"]);
  assert.deepStrictEqual(paramsAt("{|y}"), ["x", "y"]);
  assert.deepStrictEqual(paramsAt("{|z}"), ["x", "y", "z"]);
  assert.deepStrictEqual(paramsAt("{x+y[1]|}"), ["x", "y"]);
  assert.deepStrictEqual(paramsAt("{y:1|}"), ["x", "y"]);
  assert.deepStrictEqual(paramsAt("{y`a|}"), ["x", "y"]);
  assert.deepStrictEqual(paramsAt("{select x from y|}"), ["x", "y"]);
});

test("what q does not read as x, y or z is not a parameter", () => {
  // Each was checked in KDB-X: `(value f) 1` is ,`x for every one of them.
  for (const body of ['`y', '"y"', "yy", "y1", "y_", ".z.y", "a.y", "y.a", "`a`y", "{y}x", "x / y is a comment\n ", "0Nz", "`:dir/y", "1"]) {
    const params = paramsAt(`{${body}|}`);
    assert.ok(params.length <= 1, `${body}: ${params}`);
  }
  assert.deepStrictEqual(paramsAt("{.z.x|}"), []);
  assert.deepStrictEqual(paramsAt('{"x"|}'), []);
  assert.deepStrictEqual(paramsAt("{`x|}"), []);
  assert.deepStrictEqual(paramsAt("{|}"), []);
});

test("the innermost lambda at the cursor is the one found", () => {
  const text = "f:{[a] g:{[b] b*2}; g a}";
  assert.deepStrictEqual(parameters(text, lambdaAt(text, text.indexOf("b*"))), ["b"]);
  assert.deepStrictEqual(parameters(text, lambdaAt(text, text.indexOf("g a"))), ["a"]);
  // An implicit lambda inside: its x is its own, not the outer's.
  const nested = "{[a] {x+1} each a}";
  assert.deepStrictEqual(parameters(nested, lambdaAt(nested, nested.indexOf("+1"))), ["x"]);
  assert.deepStrictEqual(paramsAt("{z+{x}|y}"), ["x", "y", "z"]);
  assert.deepStrictEqual(paramsAt("{1+{x|}2}"), ["x"]);
  // Before the lambda on its line: that line's lambda.
  assert.deepStrictEqual(paramsAt("|f:{[a] a}"), ["a"]);
  assert.strictEqual(paramsAt("a:1|\nf:{[a] a}"), undefined);
  assert.strictEqual(paramsAt("|a:1"), undefined);
});

test("braces in strings and comments are not lambdas", () => {
  assert.deepStrictEqual(paramsAt('f:{[a] s:"}{"; a|}'), ["a"]);
  assert.deepStrictEqual(paramsAt('f:{[a] s:"\\"}"; a|}'), ["a"]);
  assert.deepStrictEqual(paramsAt("f:{[a] / a } in a comment\n  a|}"), ["a"]);
  // A comment line, a block comment, and a lone backslash that ends the script.
  const text = "/ {[x] x}\nf:{[a]\n  a}\n/\n{[b] b}\n\\\ng:{[c] c}\n\\\nh:{[d] d}";
  assert.deepStrictEqual(lambdas(text).map((l) => l.explicit), [["a"], ["c"]]);
  // A system command line is not code.
  assert.deepStrictEqual(lambdas("\\d .x\nf:{x}").length, 1);
  assert.deepStrictEqual(lambdas("\\ls {").length, 0);
  // A slash that is an adverb is code.
  const mask = codeMask("f:{x+/y}");
  assert.ok(mask.every(Boolean));
  // An unbalanced brace is no lambda.
  assert.deepStrictEqual(lambdas("f:{[a] a"), []);
});

test("one-line lambdas: the statement goes straight after the parameters, and comes out byte for byte", () => {
  const cases = [
    ["f:{[a;b] a+|b}", "f:{[a;b]@[`.qlint.cache.p1a2b3c set;(a;b);::];@[`a`b set';(a;b);::]; a+b}"],
    ["f:{[a]a|*2}", "f:{[a]@[`.qlint.cache.p1a2b3c set;a;::];@[`a set;a;::];a*2}"],
    ["g:{x|*2}", "g:{@[`.qlint.cache.p1a2b3c set;x;::];@[`x set;x;::];x*2}"],
    ["h:{x+y|+z}", "h:{@[`.qlint.cache.p1a2b3c set;(x;y;z);::];@[`x`y`z set';(x;y;z);::];x+y+z}"],
    ["k:{[a] |}", "k:{[a]@[`.qlint.cache.p1a2b3c set;a;::];@[`a set;a;::]; }"],
    ["m:{[a] a / note }\n |}\n", "m:{[a]@[`.qlint.cache.p1a2b3c set;a;::];@[`a set;a;::]; a / note }\n }\n"],
    ["f:{[a] g:{[b] |b}; g a}", "f:{[a] g:{[b]@[`.qlint.cache.p1a2b3c set;b;::];@[`b set;b;::]; b}; g a}"],
  ];
  for (const [marked, expected] of cases) {
    const { text, offset, toggle, after } = toggled(marked);
    assert.strictEqual(toggle.kind, "insert", marked);
    assert.strictEqual(after, expected, marked);
    // Toggled again anywhere in the lambda, it comes out.
    const back = apply(after, offset);
    assert.strictEqual(back.toggle.kind, "remove", marked);
    assert.strictEqual(back.after, text, marked);
  }
});

test("multi-line lambdas: the statement gets a line of its own, indented as the body", () => {
  const cases = [
    ["f:{[a;b]\n  c:a+b;\n  |c*2}\n", "f:{[a;b]\n  @[`.qlint.cache.p1a2b3c set;(a;b);::];@[`a`b set';(a;b);::];\n  c:a+b;\n  c*2}\n"],
    // Tabs, trailing spaces on the { line, CRLF and a blank line first.
    ["f:{[a]  \r\n\r\n\t\ta|+1\r\n\t}", "f:{[a]  \r\n\t\t@[`.qlint.cache.p1a2b3c set;a;::];@[`a set;a;::];\r\n\r\n\t\ta+1\r\n\t}"],
    ["g:{\n    x|+y}", "g:{\n    @[`.qlint.cache.p1a2b3c set;(x;y);::];@[`x`y set';(x;y);::];\n    x+y}"],
    // A comment after the parameters keeps the statement on the { line.
    ["f:{[a] / why\n  |a}", "f:{[a]@[`.qlint.cache.p1a2b3c set;a;::];@[`a set;a;::]; / why\n  a}"],
    // A nested multi-line lambda, indented deeper.
    ["f:{[a]\n  g:{[b]\n    |b*2};\n  g a}", "f:{[a]\n  g:{[b]\n    @[`.qlint.cache.p1a2b3c set;b;::];@[`b set;b;::];\n    b*2};\n  g a}"],
    // Body text on the { line: straight after the parameters.
    ["f:{[a] b:a;\n  |b}", "f:{[a]@[`.qlint.cache.p1a2b3c set;a;::];@[`a set;a;::]; b:a;\n  b}"],
  ];
  for (const [marked, expected] of cases) {
    const { text, offset, toggle, after } = toggled(marked);
    assert.strictEqual(toggle.kind, "insert", JSON.stringify(marked));
    assert.strictEqual(after, expected, JSON.stringify(marked));
    const back = apply(after, offset);
    assert.strictEqual(back.toggle.kind, "remove", JSON.stringify(marked));
    assert.strictEqual(back.after, text, JSON.stringify(marked));
  }
});

test("removal from the inserted line itself, and from an outer lambda's other lambda", () => {
  const after = "f:{[a]\n  .qlint.cache.p1a2b3c:a;`a set .qlint.cache.p1a2b3c;\n  a}";
  assert.strictEqual(apply(after, after.indexOf("set")).after, "f:{[a]\n  a}");
  // The outer lambda cached; the inner one toggles on its own.
  const both = "f:{[a].qlint.cache.p1a2b3c:a;`a set .qlint.cache.p1a2b3c; {x} a}";
  const inner = toggleAt(both, both.indexOf("{x}") + 1, () => 0);
  assert.strictEqual(inner.kind, "insert");
  assert.strictEqual(inner.text, "@[`.qlint.cache.p000000 set;x;::];@[`x set;x;::];");
});

test("refusals: no lambda, no parameters, and .qlint.cache text q-lint did not insert", () => {
  const refused = (marked) => {
    const { toggle } = toggled(marked);
    assert.strictEqual(toggle.kind, "refuse", marked);
    return toggle.message;
  };
  assert.match(refused("a:1|+2"), /in no lambda/);
  assert.match(refused("f:{[] 4|2}"), /takes no parameters/);
  assert.match(refused("f:{4|2}"), /reads none of x, y and z/);
  assert.match(refused("f:{.z.x|}"), /reads none of x, y and z/);
  const unrecognised = /did not insert, or one edited since/;
  // Hand-edited: the parameters changed since it was inserted.
  assert.match(refused("f:{[a;c].qlint.cache.p1a2b3c:(a;b);`a`b set'.qlint.cache.p1a2b3c; a|}"), unrecognised);
  // Not first in the body.
  assert.match(refused("f:{[a] 1;.qlint.cache.p1a2b3c:a;`a set .qlint.cache.p1a2b3c; a|}"), unrecognised);
  // A different shape, or an id q-lint does not make.
  assert.match(refused("f:{[a].qlint.cache.p1a2b3c:a; a|}"), unrecognised);
  assert.match(refused("f:{[a].qlint.cache.mine:a;`a set .qlint.cache.mine; a|}"), unrecognised);
  // Recognised, but named again elsewhere in the body.
  assert.match(refused("f:{[a].qlint.cache.p1a2b3c:a;`a set .qlint.cache.p1a2b3c; .qlint.cache.p1a2b3c|}"), unrecognised);
  // A lambda with no parameters that names it.
  assert.match(refused("f:{[] .qlint.cache.x|}"), unrecognised);
  // In a string or a comment it is not code, and the lambda toggles as usual.
  assert.strictEqual(toggled('f:{[a] ".qlint.cache.p"; a|}').toggle.kind, "insert");
  assert.strictEqual(toggled("f:{[a] a / .qlint.cache.p1a2b3c|\n }").toggle.kind, "insert");
});

test("the status bar counts the cached lambdas in the file", () => {
  assert.strictEqual(cachedLambdas("f:{[a] a}"), 0);
  const one = "f:{[a].qlint.cache.p1a2b3c:a;`a set .qlint.cache.p1a2b3c; a}";
  assert.strictEqual(cachedLambdas(one), 1);
  const two = one + "\ng:{\n  .qlint.cache.p000001:(x;y);`x`y set'.qlint.cache.p000001;\n  x+y}";
  assert.strictEqual(cachedLambdas(two), 2);
  // An unrecognised one is not counted.
  assert.strictEqual(cachedLambdas("f:{[a].qlint.cache.p1a2b3c:a; a}"), 0);
  assert.strictEqual(cachedText(0), undefined);
  assert.match(cachedText(1), /params cached$/);
  assert.match(cachedText(2), /params cached \(2\)$/);
  // A second cached lambda never reuses the first one's id.
  const t = toggleAt(one + "\ng:{[b] b}", one.length + 5, fixed);
  assert.strictEqual(t.kind, "insert");
  assert.ok(!t.text.includes(ID), t.text);
});

test("a number followed by _ ends at it: 1_x drops from x, and reads x", () => {
  // q has no `_` in a number, so `1_x` is 1, drop, x: `{1_x}` takes x and
  // `{-2_y}` takes x and y (KDB-X and PeachQ agree).
  assert.deepStrictEqual(paramsAt("f:{|1_x}"), ["x"]);
  assert.deepStrictEqual(paramsAt("f:{|-2_y}"), ["x", "y"]);
  assert.deepStrictEqual(paramsAt("f:{|1_z}"), ["x", "y", "z"]);
  assert.strictEqual(toggleAt("f:{1_x}", 3, fixed).kind, "insert");
  // A name keeps its `_`: `x_y` is one name, not x drop y.
  assert.deepStrictEqual(paramsAt("f:{|x_y;z_1;y}"), ["x", "y"]);
});

test("a parameter list with a comment in it is still the lambda's parameters (#1949)", () => {
  assert.deepStrictEqual(paramsAt("f:{[a; / first\n b] a+|b}"), ["a", "b"]);
  assert.deepStrictEqual(paramsAt("f:{[a; / the [first], \"quoted\"; one\n b / and } the last\n ] a+|b}"), ["a", "b"]);
  assert.deepStrictEqual(paramsAt("f:{[ / none yet\n ] 4|2}"), []);
  // The statement goes after the list, not before it.
  const one = toggled("f:{[a; / first\n b] x+a+|b}");
  assert.strictEqual(one.toggle.kind, "insert");
  assert.deepStrictEqual(one.toggle.params, ["a", "b"]);
  assert.strictEqual(one.after, "f:{[a; / first\n b]@[`.qlint.cache.p1a2b3c set;(a;b);::];@[`a`b set';(a;b);::]; x+a+b}");
  // And comes out again, byte for byte.
  const back = apply(one.after, one.after.indexOf("x+a"));
  assert.strictEqual(back.toggle.kind, "remove");
  assert.strictEqual(back.after, one.text);
  // What is no list of names is none still: a string, or an index.
  assert.deepStrictEqual(paramsAt('f:{["a" b] |x}'), ["x"]);
  assert.deepStrictEqual(paramsAt("f:{[a 1] |x}"), ["x"]);
  // A literal slot is a pattern, which KDB-X reads as a parameter list:
  // `(value f)1` of `{[a; / b]\n 1] 0|x}` is `a`1, and `x` there a global
  // (#2332).
  assert.deepStrictEqual(paramsAt("f:{[a; / b]\n 1] |x}"), ["a"]);
});

// Inserted before #2407 under a \d, unqualified: still recognised and removed.
test("a statement inserted unqualified under \\d before #2407 is still removed (#2407)", () => {
  const source = "\\d .ns\nf:{[a;b] a+b}\n";
  const old = source.replace("]", "]" + cacheStatement("p000001", ["a", "b"]));
  const t = toggleAt(old, old.indexOf("a+b"));
  assert.strictEqual(t.kind, "remove");
  assert.strictEqual(old.slice(0, t.start) + old.slice(t.end), source);
  assert.strictEqual(cacheStatement("p000001", ["a"], ".ns"), "@[`.qlint.cache.p000001 set;a;::];@[`.ns.a set;a;::];");
});
