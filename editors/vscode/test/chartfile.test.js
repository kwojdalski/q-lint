// Charts from a file (`chartfile.ts`, `chartcli.ts`): the edges of reading
// a CSV or JSON table into a grid. The main path is in dbtools.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gridFromCsv, gridFromJson, gridFromFile, chartFromGrid } = require("../out/chartfile.js");
const { main } = require("../out/chartcli.js");

/// Run the chart command line on `content` saved as `name`: its exit code and what it said.
async function cli(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-chartfile-"));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const said = [];
    const io = { out: (s) => said.push(s), err: (s) => said.push(s), stdin: () => "" };
    const code = await main([file, "-o", path.join(dir, "out.svg")], io);
    return { code, said: said.join("") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a CSV holding only an empty quoted field has no header row, and says so (#1939)", async () => {
  for (const text of ['""', '""\n', '\n""\n\n', '﻿""\r\n']) {
    assert.throws(() => gridFromCsv(text), { name: "Error", message: "the file has no header row" }, JSON.stringify(text));
  }
  assert.deepStrictEqual(await cli("q.csv", '""\n'), { code: 1, said: "chart: the file has no header row\n" });
  // A quoted name is a header, with no rows under it.
  assert.deepStrictEqual(gridFromCsv('"a"\n').columns.map((c) => c.name), ["a"]);
});
