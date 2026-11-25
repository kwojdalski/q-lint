// Paste JSON as q against a real q (#968): for hand-picked and random JSON -
// nested objects and arrays, tables, mixed lists, empty ones, nulls among
// numbers, strings with quotes, escapes, control characters and UTF-8,
// keys that are no q name - the q jsonq.ts writes evaluates to what `.j.k`
// reads from the same text. Copy as JSON's query is checked to give `.j.j`
// of the value. Needs QLINT_TEST_Q, as the other real-q tests.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { jsonToQ, toJsonQuery } = require("../out/jsonq.js");
const { qString } = require("../out/qliteral.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

const STRINGS = ["", "x", "é", "ab", 'say "hi"', "back\\slash", "line\nbreak", "tab\t", "\u0001", "日本", "a b"];
const KEYS = ["a", "b", "sym", "count", "a b", "", "é", "x1", "_y", "1st"];

function number(r) {
  return pick(r, [0, -0, 1, -1, 1.5, 0.1, 1e-7, 1e21, 123456789012, 2 ** 53, -(2 ** 53), Math.PI, (r() - 0.5) * 10 ** Math.floor(r() * 40 - 20)]);
}

function json(r, depth) {
  const leaf = () => pick(r, [null, true, false, number(r), number(r), pick(r, STRINGS)]);
  if (depth <= 0) {
    return leaf();
  }
  switch (Math.floor(r() * 7)) {
    case 0: // numbers, some null
      return Array.from({ length: Math.floor(r() * 4) }, () => (r() < 0.2 ? null : number(r)));
    case 1:
      return Array.from({ length: 1 + Math.floor(r() * 3) }, () => r() < 0.5);
    case 2: {
      // A table: objects with one set of keys.
      const keys = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, KEYS)))];
      return Array.from({ length: 1 + Math.floor(r() * 3) }, () => Object.fromEntries(keys.map((k) => [k, json(r, depth - 2)])));
    }
    case 3:
      return Array.from({ length: Math.floor(r() * 4) }, () => json(r, depth - 1));
    case 4: {
      const keys = [...new Set(Array.from({ length: Math.floor(r() * 4) }, () => pick(r, KEYS)))];
      return Object.fromEntries(keys.map((k) => [k, json(r, depth - 1)]));
    }
    default:
      return leaf();
  }
}

test("each JSON pasted as q is what .j.k reads from it", { skip }, () => {
  const lines = ['ck:{[i;e] r:@[value;e;{`$"error ",x}]; if[not 1b~r; -1 "FAIL ",string[i]," ",e," -> ",-3!r]}'];
  const texts = [
    '{"a":1,"b":"x"}', "[1,2,3]", "[]", "{}", '[1,"a"]', '["a","b"]', '[{"a":1},{"a":2}]', '[{"a":1},{"b":2}]', "null", "true", "[true,false]",
    "[null,1]", '"x"', '""', "1.5", "[[1,2],[3]]", '{"a":null}', '[{"a":1,"b":"x"},{"a":2,"b":"yy"}]', "[true,1]", '["a",null]', '{"a b":1}',
    '[{"a":[1]},{"a":[2]}]', "[null,null]", "[true,null]", '{"a":true,"b":false}', '{"a":{"b":1}}', '[{"a":1,"b":2},{"b":3,"a":4}]',
    '[{"count":1}]', '{"":1}', '[{}, {}]', '[[]]', '{"a":[]}', '{"a":{"x":1},"b":{"x":2}}', '"\\u00e9\\u0001"', "1e21", "-0", "123456789012",
    // A repeated key, and whole numbers past a long (#2185).
    '{"a":1,"a":2}', '{"a":1,"b":2,"a":3}', '[{"a":1,"a":2},{"a":3,"a":4}]', '[{"a":1,"b":2},{"a":3,"a":4}]', '{"a":{"x":1,"x":"y"}}',
    "123456789012345678901234567890", "-123456789012345678901234567890", "[18446744073709551616,1]", "9223372036854775807", "-9223372036854775809", "1234567890123456789012.5",
  ];
  const r = rng(968);
  for (let i = 0; i < 300; i++) {
    texts.push(JSON.stringify(json(r, 4)));
  }
  texts.forEach((text, i) => {
    const got = jsonToQ(text);
    assert.ok("code" in got, text);
    // Through -9!-8!: KDB-X's .j.k leaves an object's one value in a general
    // list, `(1f)` held unlike `enlist 1f`, which ~ tells apart until the
    // value is serialized, as it is on its way to any client.
    lines.push(`ck[${i};${JSON.stringify(`(-9!-8!.j.k ${qString(text)})~${got.code}`)}]`);
  });
  // Copy as JSON: the query gives .j.j of the expression's value.
  lines.push(`ck[1000;${JSON.stringify(`(.j.j ([] a:1 2; b:\`x\`y))~${toJsonQuery("([] a:1 2; b:`x`y)")}`)}]`);
  // Several statements run one after the other, as Run Selection runs
  // them, and the last one's value is copied (#1969).
  const copies = [
    ["bb:1\n2 3", "2 3"],
    ["tt:([] a:1 2 3)\nselect from tt where a>1", "([] a:2 3)"],
    ["aa:1\naa+1", "2"],
    ["ff:{[u]\n u+1}\nff 2", "3"],
    ["/ a note\n1+1 / and another", "2"],
    ["w:7", "(::)"],
    ["w", "7"],
    ["w\n", "7"],
    ["`a`b!1 2", "`a`b!1 2"],
    ["`a\n`b", "`b"],
    ["1\n\"x\"", '"x"'],
  ];
  copies.forEach(([code, expected], i) => lines.push(`ck[${1001 + i};${JSON.stringify(`(.j.j ${expected})~${toJsonQuery(code)}`)}]`));
  lines.push('ck[1100;"1~bb"]');
  lines.push('-1 "DONE";', "exit 0");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-json-"));
  const script = path.join(dir, "json.q");
  fs.writeFileSync(script, `${lines.join("\n")}\n`);
  const run = spawnSync(`${Q} ${script} -q`, { shell: true, encoding: "utf8", timeout: 60000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /DONE/, out.slice(0, 2000));
  const failed = out.split("\n").filter((l) => l.startsWith("FAIL"));
  assert.deepStrictEqual(failed, [], failed.map((f) => `${f}\n${texts[Number(f.split(" ")[1])]}`).join("\n"));
});
