// Discovery servers (#874): how a server and its auth header are read, how
// the Processes view is built with what servers listed, the setting, and the
// fetch itself against a local HTTP server - good, bad and slow answers. Run
// after `tsc`; nothing here needs an editor or a q process.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const pkg = require("../package.json");
const {
  EMPTY_STATE,
  authHeader,
  children,
  fetchProcesses,
  findDiscovered,
  parseServers,
  qualified,
  serverDescription,
  serverLabelProblem,
  toDownload,
  urlProblem,
} = require("../out/discovery.js");
const { readDiscovery } = require("../out/liveconfig.js");
const { needsRestart } = require("../out/settings.js");

const proc = (label, tags = [], port = 5000) => ({ label, host: "h", port, tags });
const listed = (processes, problems = []) => ({ ...EMPTY_STATE, processes, problems, fetchedAt: 1 });

test("a server has a label without a /, not taken, and an http or https URL", () => {
  assert.strictEqual(serverLabelProblem("desk", new Set()), undefined);
  assert.strictEqual(serverLabelProblem(" ", new Set()), "A label is needed.");
  assert.strictEqual(serverLabelProblem("a/b", new Set()), "A discovery server's label cannot hold a /.");
  assert.strictEqual(serverLabelProblem("desk ", new Set(["desk"])), "That label is taken.");
  assert.strictEqual(urlProblem("https://x.example/processes"), undefined);
  assert.strictEqual(urlProblem("http://127.0.0.1:8080"), undefined);
  assert.strictEqual(urlProblem("ftp://x"), "The URL must be http or https.");
  assert.strictEqual(urlProblem("not a url"), "Not a URL.");
});

test("stored servers are read, and anything that is not one dropped", () => {
  assert.deepStrictEqual(
    parseServers([
      { label: " a ", url: "http://a" },
      { label: "a", url: "http://again" },
      { label: "b/c", url: "http://b" },
      { label: "d", url: "file:///x" },
      { label: "e" },
      7,
      { label: "f", url: "https://f" },
    ]),
    [
      { label: "a", url: "http://a" },
      { label: "f", url: "https://f" },
    ],
  );
  assert.deepStrictEqual(parseServers(undefined), []);
});

test("the secret is the Authorization value, or Name: value", () => {
  assert.strictEqual(authHeader(undefined), undefined);
  assert.strictEqual(authHeader("  "), undefined);
  assert.deepStrictEqual(authHeader("Bearer abc"), ["Authorization", "Bearer abc"]);
  assert.deepStrictEqual(authHeader("Basic dXNlcjpwYXNz"), ["Authorization", "Basic dXNlcjpwYXNz"]);
  assert.deepStrictEqual(authHeader("X-Api-Key: k1"), ["X-Api-Key", "k1"]);
  // A raw key holding a colon, with no space after it, is still a value.
  assert.deepStrictEqual(authHeader("abc:def"), ["Authorization", "abc:def"]);
});

test("the view lists saved processes by tag, then the discovery servers", () => {
  const saved = [proc("rdb", ["prod"]), proc("scratch")];
  const servers = [
    { server: { label: "zeta", url: "http://z" }, state: listed([proc("hdb"), proc("rdb", ["prod"])]) },
    { server: { label: "alpha", url: "http://a" }, state: { ...EMPTY_STATE, loading: true } },
  ];
  const top = children(saved, servers);
  assert.deepStrictEqual(
    top.map((r) => r.kind + (r.tag ? ` ${r.tag}` : r.process ? ` ${r.process.label}` : "")),
    ["tag prod", "process scratch", "servers"],
  );
  // No group when there is no server.
  assert.deepStrictEqual(children(saved, []).map((r) => r.kind), ["tag", "process"]);
  const group = children(saved, servers, top[2]);
  assert.deepStrictEqual(group.map((r) => r.server.label), ["alpha", "zeta"]);
  assert.deepStrictEqual(children(saved, servers, group[0]), [{ kind: "note", level: "info", text: "Loading..." }]);
  // A discovered process is under its server, by label, and may share a saved label.
  assert.deepStrictEqual(
    children(saved, servers, group[1]).map((r) => `${r.kind} ${r.server}/${r.process.label}`),
    ["discovered zeta/hdb", "discovered zeta/rdb"],
  );
  assert.deepStrictEqual(children(saved, servers, children(saved, servers, group[1])[0]), []);
});

test("a server's failure, skipped entries and emptiness are notes under it", () => {
  const server = { label: "s", url: "http://s" };
  const under = (state) => children([], [{ server, state }], { kind: "server", server, state });
  assert.deepStrictEqual(under({ ...EMPTY_STATE, error: "it answered 500", fetchedAt: 1 }), [
    { kind: "note", level: "error", text: "Could not load: it answered 500." },
  ]);
  assert.deepStrictEqual(under(EMPTY_STATE), [
    { kind: "note", level: "info", text: "Not loaded yet. Reload to list its processes." },
  ]);
  assert.deepStrictEqual(under({ ...EMPTY_STATE, removed: true }), [
    { kind: "note", level: "info", text: "Processes removed. Reload to list them again." },
  ]);
  assert.deepStrictEqual(under(listed([])), [{ kind: "note", level: "info", text: "It lists no processes." }]);
  const many = Array.from({ length: 12 }, (_, i) => `Entry ${i + 1} has no label.`);
  const rows = under(listed([proc("a")], many));
  assert.strictEqual(rows.length, 12);
  assert.deepStrictEqual(rows[0], { kind: "note", level: "warning", text: "Skipped: Entry 1 has no label." });
  assert.deepStrictEqual(rows[10], { kind: "note", level: "warning", text: "Skipped 2 more." });
  assert.strictEqual(rows[11].kind, "discovered");
  assert.strictEqual(serverDescription(listed([proc("a")])), "1 process");
  assert.strictEqual(serverDescription(listed([proc("a"), proc("b")])), "2 processes");
  assert.strictEqual(serverDescription({ ...EMPTY_STATE, loading: true }), "loading");
  assert.strictEqual(serverDescription({ ...EMPTY_STATE, error: "x" }), "failed");
  assert.strictEqual(serverDescription(EMPTY_STATE), "");
});

test("a discovered process is named server/label, or by a label only one server lists", () => {
  const servers = [
    { server: { label: "a", url: "http://a" }, state: listed([proc("rdb", [], 1), proc("hdb", [], 2)]) },
    { server: { label: "b", url: "http://b" }, state: listed([proc("rdb", [], 3)]) },
  ];
  assert.strictEqual(qualified("a", "rdb"), "a/rdb");
  assert.deepStrictEqual(findDiscovered(servers, "b/rdb"), { ...proc("b/rdb", [], 3), server: "b" });
  assert.deepStrictEqual(findDiscovered(servers, "hdb"), { ...proc("a/hdb", [], 2), server: "a" });
  // Two servers list rdb: the bare label names neither.
  assert.strictEqual(findDiscovered(servers, "rdb"), undefined);
  assert.strictEqual(findDiscovered(servers, "c/rdb"), undefined);
});

test("a download adds what is not saved, and never replaces a saved process", () => {
  const saved = [proc("rdb", ["mine"], 1)];
  assert.deepStrictEqual(toDownload(saved, [proc("rdb", [], 2), proc("hdb")]), {
    added: [proc("hdb")],
    skipped: ["rdb"],
  });
});

test("the discovery setting is read, with the default package.json declares, and does not restart the server", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: discovery servers");
  const declared = section.properties;
  const read = new Map();
  const settings = readDiscovery((key, fallback) => {
    read.set(key, fallback);
    return fallback;
  });
  for (const [key, spec] of Object.entries(declared)) {
    const short = key.replace(/^q-lint\./, "");
    assert.ok(read.has(short), `${key} is declared but never read`);
    assert.deepStrictEqual(read.get(short), spec.default, key);
    const affects = (s) => key === s || key.startsWith(`${s}.`);
    assert.strictEqual(needsRestart(affects), false, key);
  }
  assert.strictEqual(read.size, Object.keys(declared).length);
  assert.deepStrictEqual(settings, { refreshInterval: 30 });
  const set = (v) => readDiscovery((key, fallback) => (key === "discovery.refreshInterval" ? v : fallback)).refreshInterval;
  assert.strictEqual(set(0), 0);
  assert.strictEqual(set(5), 5);
  assert.strictEqual(set(-1), 30);
  assert.strictEqual(set(1.5), 30);
  assert.strictEqual(set(100000), 1440);
  assert.strictEqual(declared["q-lint.discovery.refreshInterval"].maximum, 1440);
});

// --- the fetch, against a local server

const json = "application/json; charset=utf-8";
const routes = {
  "/list": (req, res) => {
    res.writeHead(200, { "content-type": json });
    res.end(JSON.stringify([{ label: "rdb", host: "127.0.0.1", port: 5001, tags: ["dev"] }, { label: "bad" }]));
  },
  "/wrapped": (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ processes: [{ label: "hdb", host: "h", port: "5002", user: "u", tls: true }] }));
  },
  "/auth": (req, res) => {
    res.writeHead(200, { "content-type": json });
    res.end(JSON.stringify([{ label: req.headers["x-api-key"] ?? req.headers.authorization ?? "none", host: "h", port: 1 }]));
  },
  "/malformed": (req, res) => {
    res.writeHead(200, { "content-type": json });
    res.end("[{label: rdb");
  },
  "/shape": (req, res) => {
    res.writeHead(200, { "content-type": json });
    res.end('{"servers": []}');
  },
  "/500": (req, res) => {
    res.writeHead(500, { "content-type": json });
    res.end("{}");
  },
  "/html": (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html></html>");
  },
  // 6 MB chunked, so no content-length gives it away: the cap is on what is read.
  "/huge": (req, res) => {
    res.writeHead(200, { "content-type": json });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const more = () => {
      while (sent < 96 && !res.destroyed) {
        sent++;
        if (!res.write(chunk)) {
          res.once("drain", more);
          return;
        }
      }
      res.end();
    };
    more();
  },
  "/huge-declared": (req, res) => {
    res.writeHead(200, { "content-type": json, "content-length": String(6 * 1024 * 1024) });
    res.end();
  },
  "/silent": () => {},
  // Headers at once, then a body that never ends.
  "/stall": (req, res) => {
    res.writeHead(200, { "content-type": json });
    res.write("[");
  },
};

async function withServer(run) {
  const server = http.createServer((req, res) => (routes[req.url] ?? routes["/500"])(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a list, or {processes: [...]}, is read and its bad entries said", async () => {
  await withServer(async (base) => {
    assert.deepStrictEqual(await fetchProcesses(`${base}/list`), {
      processes: [{ label: "rdb", host: "127.0.0.1", port: 5001, tags: ["dev"] }],
      problems: ["Entry 2 (bad) has no host."],
    });
    assert.deepStrictEqual(await fetchProcesses(`${base}/wrapped`), {
      processes: [{ label: "hdb", host: "h", port: 5002, user: "u", tags: [], tls: true }],
      problems: [],
    });
    assert.deepStrictEqual(await fetchProcesses(`${base}/shape`), {
      processes: [],
      problems: ["Expected a list of processes, or an object with a `processes` list."],
    });
  });
});

test("the auth header is sent as Authorization, or under its own name", async () => {
  await withServer(async (base) => {
    const label = async (secret) => (await fetchProcesses(`${base}/auth`, { secret })).processes[0].label;
    assert.strictEqual(await label(undefined), "none");
    assert.strictEqual(await label("Bearer t0k"), "Bearer t0k");
    assert.strictEqual(await label("X-Api-Key: k1"), "k1");
  });
});

test("a bad answer is refused with what was wrong", async () => {
  await withServer(async (base) => {
    await assert.rejects(fetchProcesses(`${base}/malformed`), /^Error: its answer is not JSON: /);
    await assert.rejects(fetchProcesses(`${base}/500`), { message: "it answered 500 Internal Server Error" });
    await assert.rejects(fetchProcesses(`${base}/html`), { message: "it answered text/html, not application/json" });
    await assert.rejects(fetchProcesses(`${base}/huge`), { message: `its answer is over ${5 * 1024 * 1024} bytes` });
    await assert.rejects(fetchProcesses(`${base}/huge-declared`), { message: `its answer is over ${5 * 1024 * 1024} bytes` });
    await assert.rejects(fetchProcesses(`${base}/huge`, { maxBytes: 1000 }), { message: "its answer is over 1000 bytes" });
  });
});

test("a server that never answers, or never finishes, times out", async () => {
  await withServer(async (base) => {
    const t0 = Date.now();
    await assert.rejects(fetchProcesses(`${base}/silent`, { timeoutMs: 300 }), { message: "no answer within 0.3 s" });
    await assert.rejects(fetchProcesses(`${base}/stall`, { timeoutMs: 300 }), { message: "no answer within 0.3 s" });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });
});

test("a server that is not there is said to be unreachable", async () => {
  // Bind a port, then free it: nothing listens there now.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(fetchProcesses(`http://127.0.0.1:${port}/`), /^Error: could not reach it: .*ECONNREFUSED/);
});

test("an answer with a byte order mark, or in the charset it names, is read", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/bom") {
      res.writeHead(200, { "content-type": json });
      res.end("﻿" + JSON.stringify([{ label: "rdb", host: "h", port: 1 }]));
    } else {
      // "Zürich" in Latin-1: ü is the one byte 0xFC.
      res.writeHead(200, { "content-type": "application/json; charset=ISO-8859-1" });
      res.end(Buffer.from(JSON.stringify([{ label: "Zürich", host: "h", port: 1 }]), "latin1"));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepStrictEqual((await fetchProcesses(`${base}/bom`)).processes.map((p) => p.label), ["rdb"]);
    assert.deepStrictEqual((await fetchProcesses(`${base}/latin1`)).processes.map((p) => p.label), ["Zürich"]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a redirect to another origin is not sent the auth header", async () => {
  const seen = [];
  const other = http.createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization, key: req.headers["x-api-key"] });
    res.writeHead(200, { "content-type": json });
    res.end(JSON.stringify([{ label: "elsewhere", host: "h", port: 1 }]));
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const elsewhere = `http://127.0.0.1:${other.address().port}/list`;
  const first = http.createServer((req, res) => {
    if (req.url === "/same") {
      res.writeHead(302, { location: "/here" });
      res.end();
    } else if (req.url === "/here") {
      res.writeHead(200, { "content-type": json });
      res.end(JSON.stringify([{ label: req.headers["x-api-key"] ?? "none", host: "h", port: 1 }]));
    } else if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
    } else {
      res.writeHead(307, { location: elsewhere });
      res.end();
    }
  });
  await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${first.address().port}`;
  try {
    for (const secret of ["X-Api-Key: k1", "Bearer t0k"]) {
      assert.deepStrictEqual((await fetchProcesses(`${base}/away`, { secret })).processes.map((p) => p.label), ["elsewhere"]);
    }
    assert.deepStrictEqual(seen, [{ authorization: undefined, key: undefined }, { authorization: undefined, key: undefined }]);
    // On the same origin the header follows.
    assert.deepStrictEqual((await fetchProcesses(`${base}/same`, { secret: "X-Api-Key: k1" })).processes.map((p) => p.label), ["k1"]);
    await assert.rejects(fetchProcesses(`${base}/loop`), /redirect/);
  } finally {
    for (const s of [first, other]) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
  }
});

// A URL's user and password: fetch refuses every such request, and its
// error, shown under the server's row, spelled the URL out password and all.
// The password was also kept in plain globalState and shown in the tooltip.
test("a URL with a user or password is refused, and the password never shown", async () => {
  assert.strictEqual(urlProblem("https://u:pw@x.example/list"), "Put a user and password in the auth header, not the URL.");
  assert.strictEqual(urlProblem("https://u@x.example/list"), "Put a user and password in the auth header, not the URL.");
  // One stored before stays listed, so it can be edited or deleted.
  assert.deepStrictEqual(parseServers([{ label: "a", url: "https://u:pw@x.example/" }]), [{ label: "a", url: "https://u:pw@x.example/" }]);
  await withServer(async (base) => {
    const url = base.replace("://", "://u:s3cretpw@") + "/list";
    await assert.rejects(fetchProcesses(url), (error) => {
      assert.strictEqual(error.message, "its URL holds a user or password: put them in the auth header");
      return true;
    });
  });
});

// An auth header fetch cannot send: its error named the header's value -
// the secret - under the server's row, and called it unreachable.
test("an auth header that cannot be sent is refused without showing it", async () => {
  await withServer(async (base) => {
    for (const secret of ["Bearer s3cret\nmore", "X-Api-Key: s3cret\u0000", "Bearer s3cr€t"]) {
      await assert.rejects(fetchProcesses(`${base}/auth`, { secret }), (error) => {
        assert.ok(!error.message.includes("s3cr"), error.message);
        assert.strictEqual(error.message, "its auth header holds a character HTTP cannot send");
        return true;
      });
    }
  });
});

// The server row's tooltip read its label as Markdown.
test("a server's tooltip shows its label as written", () => {
  const { serverTooltip } = require("../out/discovery.js");
  assert.strictEqual(serverTooltip({ label: "*eu*_desk", url: "https://x/a_b" }), "**\\*eu\\*\\_desk**\n\nhttps://x/a\\_b");
  assert.strictEqual(serverTooltip({ label: "d", url: "https://x/" }, "10:00:00"), "**d**\n\nhttps://x/\n\nlast fetched 10:00:00");
});

// Download Processes saved a discovered process with a user, but not the
// password given when connecting to it: the saved copy sent an empty one,
// was refused, and was never asked for it - only Edit could set it.
test("a download takes along the password of each process with a user", () => {
  const { downloadedPasswords } = require("../out/discovery.js");
  const added = [{ ...proc("rdb"), user: "u" }, proc("hdb")];
  assert.deepStrictEqual(downloadedPasswords("desk", added), [["q-lint.discoveredPassword.desk/rdb", "q-lint.password.rdb"]]);
});
