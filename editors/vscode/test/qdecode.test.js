// The decoder of q's IPC bytes (src/qdecode.ts) and what the console
// formatter (src/qformat.ts) makes of what it decodes, on messages built
// here byte by byte, each as KDB-X sends it. Run after `tsc`.
const test = require("node:test");
const assert = require("node:assert");
const { decode } = require("../out/qdecode.js");
const { formatQ } = require("../out/qformat.js");

/// A whole message: the 8-byte header, then `body`.
function message(...body) {
  const b = Buffer.concat(body.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
  const head = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
  head.writeInt32LE(8 + b.length, 4);
  return Buffer.concat([head, b]);
}

function long(n) {
  const b = Buffer.alloc(9);
  b.writeInt8(-7, 0);
  b.writeBigInt64LE(BigInt(n), 1);
  return b;
}

/// What the console shows for the value `body` encodes.
function shown(...body) {
  return formatQ(decode(message(...body)), undefined).join("\n");
}

test("a primitive shows as q prints it, not as (::) (#1232)", () => {
  // KDB-X: count is unary 13, `#:`; neg unary 2, `-:`; + binary 1; / iterator 1.
  assert.strictEqual(shown([0x65, 13]), "#:");
  assert.strictEqual(shown([0x65, 2]), "-:");
  assert.strictEqual(shown([0x65, 41]), "enlist");
  assert.strictEqual(shown([0x66, 1]), "+");
  assert.strictEqual(shown([0x66, 23]), "in");
  assert.strictEqual(shown([0x67, 1]), "/");
  // (neg;1), as .Q.s1 shows it: (-:;1).
  const list = formatQ(decode(message([0, 0, 2, 0, 0, 0], [0x65, 2], long(1))), undefined);
  assert.ok(list.some((l) => l.includes("-:")), list.join("\n"));
  assert.ok(!list.some((l) => l.includes("::")), list.join("\n"));
  // The generic null is unary 0, and still (::).
  assert.strictEqual(formatQ(decode(message([0x65, 0])), undefined, 101).join(""), "::");
});
