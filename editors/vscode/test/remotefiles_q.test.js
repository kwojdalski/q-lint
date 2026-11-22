// The process file browser's q against a real process (#1044): the working
// directory, a directory listed with files and sizes (the root too), a
// missing path or a file refused as a directory, a file read up to the cap
// and no further, and a directory refused as a file. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { connect, skip } = require("./qserver.js");
const { LIST_DIRECTORY, READ_FILE, WORKING_DIRECTORY, readFileHead, readListing } = require("../out/remotefiles.js");

test("directories are listed and files read, capped", { skip }, async (t) => {
  const { connection, dir } = await connect(t, "a:1\n", { "f.txt": "hello\nworld\n", "empty.q": "" });
  fs.mkdirSync(path.join(dir, "sub dir"));
  const cwd = await connection.call(WORKING_DIRECTORY, 0);
  assert.strictEqual(fs.realpathSync(cwd), fs.realpathSync(dir));
  const listing = readListing(await connection.call(LIST_DIRECTORY, dir, 1000));
  const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
  assert.deepStrictEqual(byName["f.txt"], { name: "f.txt", file: true, size: 12 });
  assert.deepStrictEqual(byName["empty.q"], { name: "empty.q", file: true, size: 0 });
  assert.deepStrictEqual(byName["sub dir"], { name: "sub dir", file: false, size: -1 });
  assert.strictEqual(readListing(await connection.call(LIST_DIRECTORY, path.join(dir, "sub dir"), 1000)).entries.length, 0);
  // At most `lim` entries, and how many there are.
  const two = readListing(await connection.call(LIST_DIRECTORY, dir, 2));
  assert.strictEqual(two.entries.length, 2);
  assert.ok(two.total >= 4);
  assert.ok(readListing(await connection.call(LIST_DIRECTORY, "/", 5)).entries.length > 0);
  await assert.rejects(connection.call(LIST_DIRECTORY, path.join(dir, "nope"), 10), /no such directory/);
  await assert.rejects(connection.call(LIST_DIRECTORY, path.join(dir, "f.txt"), 10), /not a directory/);

  assert.deepStrictEqual(readFileHead(await connection.call(READ_FILE, path.join(dir, "f.txt"), 100)), { size: 12, text: "hello\nworld\n", cut: false, shown: 12 });
  assert.deepStrictEqual(readFileHead(await connection.call(READ_FILE, path.join(dir, "f.txt"), 3)), { size: 12, text: "hel", cut: true, shown: 3 });
  assert.deepStrictEqual(readFileHead(await connection.call(READ_FILE, path.join(dir, "empty.q"), 3)), { size: 0, text: "", cut: false, shown: 0 });
  await assert.rejects(connection.call(READ_FILE, path.join(dir, "sub dir"), 3), /not a file/);
  // Nothing was written or assigned.
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["empty.q", "f.txt", "server.q", "sub dir"]);
  assert.deepStrictEqual(await connection.call("{[x] key `.}", 0), ["a"]);
});
