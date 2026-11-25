// The problems dashboard's page (media/problems.js) under node, in
// test/smallpage.js's stand-in DOM.
const test = require("node:test");
const assert = require("node:assert");
const { loadSmallPage } = require("./smallpage.js");

const point = (commit, total, errors) => ({ commit, date: "2026-11-2" + total % 10 + "T10:00:00Z", subject: "a change", total, errors });
/// What the extension posts, with `trend` for its points.
const view = (trend) => ({ type: "problems", id: 1, folder: "src", at: 0, commit: "c".repeat(40), clean: true, summary: { total: 9, errors: 1, warnings: 8, notes: 0, files: 2, rules: [], folders: [] }, trend });

test("the trend chart is an image with a name that says the trend (#1350)", () => {
  const page = loadSmallPage(["problems.js"]);
  page.send(view([point("a1b2c3d4e5f6", 12, 3), point("b".repeat(40), 15, 4), point("c".repeat(40), 9, 1)]));
  const chart = page.find("svg")[0];
  assert.strictEqual(chart.getAttribute("role"), "img");
  assert.strictEqual(chart.getAttribute("aria-label"), "Findings over 3 commits: from 12 findings and 3 errors at a1b2c3d4 to 9 findings and 1 error at cccccccc");
  // One commit has no from and to.
  page.send(view([point("a1b2c3d4e5f6", 12, 3)]));
  assert.strictEqual(page.find("svg")[0].getAttribute("aria-label"), "Findings over 1 commit: 12 findings and 3 errors at a1b2c3d4");
  // No commit, no chart.
  page.send(view([]));
  assert.deepStrictEqual(page.find("svg"), []);
});
