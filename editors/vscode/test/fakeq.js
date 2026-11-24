// A q process played by a socket server, for the process tools' command
// tests (#1042-#1051): it answers each message with `answer(message)` (or
// `answer` itself, when it is not a function) and keeps every message,
// decoded, so a test can say what was sent - and that nothing was.
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");

/// Answered by `answer`, a message is left unanswered: a query that runs on.
const SILENT = Symbol("silent");

async function fakeQ(answer) {
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        const decoded = deserialize(message);
        sent.push(decoded);
        const reply = typeof answer === "function" ? answer(decoded) : answer;
        if (reply === SILENT) {
          continue;
        }
        const out = serialize(reply);
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    sent,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/// The first element of each message sent: the lambda's text, or the query.
const heads = (sent) => sent.map((m) => (Array.isArray(m) ? m[0] : m));

module.exports = { fakeQ, heads, SILENT };

/// The stand-in `vscode` with a saved process "rdb" (tagged `tags`) played
/// by a fake q answering `answer`, a `Live` over it, and `register` called
/// with the context and the Live; everything is torn down after `t`. The
/// stub must be required before this is called.
async function setUp(t, { tags = [], config = {}, answer = null, register = () => undefined, more = [] } = {}) {
  const { stub, vscode } = require("./vscode_stub.js");
  const { Live } = require("../out/live.js");
  stub.reset();
  Object.assign(stub.config.user, config);
  // The stub's Uri has no `from`: a virtual document's URI as text.
  vscode.Uri.from ??= (parts) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}${parts.query ? `?${parts.query}` : ""}` });
  const q = await fakeQ(answer);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags }, ...more.map((m) => ({ host: "127.0.0.1", port: q.port, tags: [], ...m }))]);
  const live = new Live(context);
  const feature = register(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  return { q, live, context, feature, stub, vscode };
}

module.exports.setUp = setUp;
