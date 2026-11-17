// Restarts run one at a time (#549). Run after `tsc`, against `out/serial.js`.
const test = require("node:test");
const assert = require("node:assert");
const { Serial } = require("../out/serial.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("tasks run one at a time, in the order asked for", async () => {
  const serial = new Serial();
  const log = [];
  let running = 0;
  const task = (name) => async () => {
    running += 1;
    assert.strictEqual(running, 1, `${name} overlapped another task`);
    log.push(`start ${name}`);
    await tick();
    log.push(`stop ${name}`);
    running -= 1;
  };
  await Promise.all([serial.run(task("a")), serial.run(task("b")), serial.run(task("c"))]);
  assert.deepStrictEqual(log, ["start a", "stop a", "start b", "stop b", "start c", "stop c"]);
});

test("a task that fails does not stop the next", async () => {
  const serial = new Serial();
  const failed = serial.run(async () => {
    throw new Error("no server");
  });
  let ran = false;
  const next = serial.run(async () => {
    ran = true;
  });
  await assert.rejects(failed, /no server/);
  await next;
  assert.ok(ran);
});
