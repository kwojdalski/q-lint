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

// read1 stops at a byte, and the bytes of a character begun but not ended
// came back with the rest: the text shown ended in U+FFFD, a character the
// file does not hold.
test("a file cut inside a UTF-8 character ends at the character before it (#1930)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, "a:1\n");
  const head = async (bytes, cap) => {
    fs.writeFileSync(path.join(dir, "cut.txt"), bytes);
    return readFileHead(await connection.call(READ_FILE, path.join(dir, "cut.txt"), cap));
  };
  const text = (s) => Buffer.from(s, "utf8");
  // Two, three and four bytes long, cut after each byte of theirs.
  assert.deepStrictEqual(await head(text("abé and more"), 3), { size: 13, text: "ab", cut: true, shown: 2 });
  assert.deepStrictEqual(await head(text("abé and more"), 4), { size: 13, text: "abé", cut: true, shown: 4 });
  for (const cap of [3, 4]) assert.deepStrictEqual(await head(text("ab€ and"), cap), { size: 9, text: "ab", cut: true, shown: 2 });
  assert.deepStrictEqual(await head(text("ab€ and"), 5), { size: 9, text: "ab€", cut: true, shown: 5 });
  for (const cap of [3, 4, 5]) assert.deepStrictEqual(await head(text("ab😀 and"), cap), { size: 10, text: "ab", cut: true, shown: 2 });
  assert.deepStrictEqual(await head(text("ab😀 and"), 6), { size: 10, text: "ab😀", cut: true, shown: 6 });
  // Nothing but the start of one: no text, and still cut.
  assert.deepStrictEqual(await head(text("€uro"), 2), { size: 6, text: "", cut: true, shown: 0 });
  // A whole file ending mid-character is shown as it is: nothing was cut.
  assert.strictEqual((await head(Buffer.from([0x61, 0xe2, 0x82]), 100)).shown, 3);
  // Bytes that are no UTF-8 - four that continue nothing - are left alone.
  assert.strictEqual((await head(Buffer.from([0x61, 0x80, 0x80, 0x80, 0x80, 0x62]), 5)).shown, 5);
  // At the cap of a megabyte, as the issue has it.
  const { FILE_LIMIT } = require("../out/remotefiles.js");
  const big = await head(Buffer.concat([Buffer.alloc(FILE_LIMIT - 1, 0x61), text("é and more")]), FILE_LIMIT);
  assert.deepStrictEqual([big.size, big.shown, big.cut, big.text.length, big.text.slice(-2)], [FILE_LIMIT + 10, FILE_LIMIT - 1, true, FILE_LIMIT - 1, "aa"]);
});

// q's cast to a symbol trims the blanks at both ends of a text, and so
// does ` sv of symbols: the path asked about was another one, so the file
// was listed as a folder, and neither it nor a folder so named opened.
test("a file or a folder whose name ends in a blank is listed and read as what it is (#2011)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, "a:1\n", { "trail ": "x", plain: "n" });
  fs.mkdirSync(path.join(dir, "dir ", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dir ", "in "), "yy");
  fs.writeFileSync(path.join(dir, "dir ", "sub", "deep"), "zzz");
  fs.mkdirSync(path.join(dir, " lead"));
  fs.writeFileSync(path.join(dir, " lead", " f "), "q");
  const list = async (...names) => readListing(await connection.call(LIST_DIRECTORY, path.join(dir, ...names), 1000)).entries.filter((e) => e.name !== "server.q");
  const read = async (...names) => readFileHead(await connection.call(READ_FILE, path.join(dir, ...names), 100)).text;
  assert.deepStrictEqual(await list(), [
    { name: " lead", file: false, size: -1 },
    { name: "dir ", file: false, size: -1 },
    { name: "plain", file: true, size: 1 },
    { name: "trail ", file: true, size: 1 },
  ]);
  assert.deepStrictEqual([await read("trail "), await read("plain")], ["x", "n"]);
  // The folder, with and without the `/` a path may end in, and what is under it.
  const inside = [{ name: "in ", file: true, size: 2 }, { name: "sub", file: false, size: -1 }];
  assert.deepStrictEqual([await list("dir "), readListing(await connection.call(LIST_DIRECTORY, `${path.join(dir, "dir ")}/`, 1000)).entries], [inside, inside]);
  assert.deepStrictEqual([await read("dir ", "in "), await read("dir ", "sub", "deep"), await list("dir ", "sub")], ["yy", "zzz", [{ name: "deep", file: true, size: 3 }]]);
  assert.deepStrictEqual([await list(" lead"), await read(" lead", " f ")], [[{ name: " f ", file: true, size: 1 }], "q"]);
  // The name without its blank is another path, and is not there.
  await assert.rejects(connection.call(READ_FILE, path.join(dir, "trail"), 100), /not a file/);
  await assert.rejects(connection.call(LIST_DIRECTORY, path.join(dir, "dir"), 10), /no such directory/);
  // Nothing was written or assigned: no file was made of a name read wrongly.
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [" lead", "dir ", "plain", "server.q", "trail "]);
  assert.deepStrictEqual(await connection.call("{[x] key `.}", 0), ["a"]);
});

// hcount and read1 open the file, and opening a FIFO with no writer blocks:
// a folder holding one stopped the single-threaded process answering anyone.
// Only a regular file is sized or read; anything else is listed, not opened.
test("a FIFO in a folder is listed without opening it, and is not read (#2157)", { skip: skip || (process.platform === "win32" && "no mkfifo") }, async (t) => {
  const { connection, dir } = await connect(t, "a:1\n", { "f.txt": "hi" });
  require("node:child_process").execFileSync("mkfifo", [path.join(dir, "pipe")]);
  fs.symlinkSync("f.txt", path.join(dir, "link"));
  // Under a second: the q is killed with its process group when the test ends.
  const soon = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("the process did not answer: it is blocked")), 3000))]);
  const listing = readListing(await soon(connection.call(LIST_DIRECTORY, dir, 1000)));
  const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
  assert.deepStrictEqual([byName.pipe, byName["f.txt"], byName.link], [
    { name: "pipe", file: true, size: -3 },
    { name: "f.txt", file: true, size: 2 },
    { name: "link", file: true, size: 2 },
  ]);
  await assert.rejects(soon(connection.call(READ_FILE, path.join(dir, "pipe"), 100)), /not a regular file/);
  assert.strictEqual(readFileHead(await soon(connection.call(READ_FILE, path.join(dir, "link"), 100))).text, "hi");
  // And the process still answers.
  assert.strictEqual(Number(await soon(connection.call("{[x] a}", 0))), 1);
});

// key answers () for a link to nothing, as for no path at all: it was listed
// as a folder, which then said "no such directory" and opened as no file.
test("a broken link is listed as an unreadable file, not a folder (#2168)", { skip: skip || (process.platform === "win32" && "no symlinks") }, async (t) => {
  const { connection, dir } = await connect(t, "a:1\n");
  fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "broken"));
  fs.mkdirSync(path.join(dir, "empty"));
  const byName = Object.fromEntries(readListing(await connection.call(LIST_DIRECTORY, dir, 1000)).entries.map((e) => [e.name, e]));
  assert.deepStrictEqual([byName.broken, byName.empty], [{ name: "broken", file: true, size: -2 }, { name: "empty", file: false, size: -1 }]);
  await assert.rejects(connection.call(READ_FILE, path.join(dir, "broken"), 100), /not a file/);
});

// find wrote each name on a line of its own, so a name holding a newline was
// two lines, neither a file: it was listed as one that cannot be read (#2542).
test("a file whose name holds a newline or a tab is listed as the file it is (#2542)", { skip: skip || (process.platform === "win32" && "no such names") }, async (t) => {
  const { connection, dir } = await connect(t, "a:1\n", { "two\nlines.txt": "x", "tab\tin.txt": "y", "plain.txt": "hello" });
  const byName = Object.fromEntries(readListing(await connection.call(LIST_DIRECTORY, dir, 1000)).entries.map((e) => [e.name, e]));
  assert.deepStrictEqual([byName["two\nlines.txt"], byName["tab\tin.txt"], byName["plain.txt"]], [
    { name: "two\nlines.txt", file: true, size: 1 },
    { name: "tab\tin.txt", file: true, size: 1 },
    { name: "plain.txt", file: true, size: 5 },
  ]);
});
