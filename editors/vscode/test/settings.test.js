// The `q-lint.*` settings as the server receives them: its command line and
// its `initializationOptions`. The defaults must be exactly what the server
// was started with before there were settings, so an untouched install
// behaves as it always has. Run after `tsc`, against `out/settings.js`.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const pkg = require("../package.json");
const { launch, needsRestart } = require("../out/settings.js");

// A WorkspaceConfiguration over `user`, the values a user set, falling back
// to the defaults package.json declares - as VS Code's does.
function configuration(user = {}) {
  const declared = pkg.contributes.configuration.properties;
  return {
    get(key, fallback) {
      if (key in user) return user[key];
      const d = declared[`q-lint.${key}`];
      return d === undefined ? fallback : d.default;
    },
    inspect(key) {
      return key in user ? { globalValue: user[key] } : {};
    },
  };
}

test("the defaults start the server as it was started before settings", () => {
  const l = launch(configuration(), "/ws");
  assert.strictEqual(l.enabled, true);
  assert.strictEqual(l.serverPath, "");
  assert.deepStrictEqual(l.args, ["--lsp"]);
  assert.deepStrictEqual(l.initializationOptions, {
    lint: { select: [], ignore: [], run: "onType", severity: {} },
    fixes: { unsafe: true },
    format: { enable: true },
    semanticTokens: { enable: true },
    workspaceIndex: { enable: true, exclude: [] },
  });
});

test("a declared profile default is not passed, a set one is", () => {
  // `style` is the declared default; passing it would override a
  // repository's own `profile`.
  assert.deepStrictEqual(launch(configuration(), undefined).args, ["--lsp"]);
  assert.deepStrictEqual(launch(configuration({ profile: "uqf" }), undefined).args, [
    "--lsp",
    "--profile",
    "uqf",
  ]);
});

test("the config file is resolved against the workspace folder", () => {
  const ws = path.resolve("/ws");
  assert.deepStrictEqual(launch(configuration({ configFile: "ci/qlinter.toml" }), ws).args, [
    "--lsp",
    "--config",
    path.join(ws, "ci/qlinter.toml"),
  ]);
  const absolute = path.resolve("/etc/qlinter.toml");
  assert.deepStrictEqual(launch(configuration({ configFile: absolute }), ws).args, [
    "--lsp",
    "--config",
    absolute,
  ]);
});

test("server arguments come after the ones settings produce", () => {
  const l = launch(configuration({ profile: "general", serverArgs: ["--isolated"] }), undefined);
  assert.deepStrictEqual(l.args, ["--lsp", "--profile", "general", "--isolated"]);
});

test("every editor-only setting reaches the server's options", () => {
  const l = launch(
    configuration({
      enable: false,
      serverPath: "  /opt/qlinter  ",
      "lint.select": ["QF", " QE ", ""],
      "lint.ignore": ["QF016"],
      "lint.run": "onSave",
      "lint.severity": { QS: "hint" },
      "fixes.unsafe": false,
      "format.enable": false,
      "semanticTokens.enable": false,
      "workspaceIndex.enable": false,
      "workspaceIndex.exclude": ["vendor/**"],
    }),
    undefined,
  );
  assert.strictEqual(l.enabled, false);
  assert.strictEqual(l.serverPath, "/opt/qlinter");
  assert.deepStrictEqual(l.initializationOptions, {
    lint: { select: ["QF", "QE"], ignore: ["QF016"], run: "onSave", severity: { QS: "hint" } },
    fixes: { unsafe: false },
    format: { enable: false },
    semanticTokens: { enable: false },
    workspaceIndex: { enable: false, exclude: ["vendor/**"] },
  });
});

test("an unknown run mode falls back to linting on type", () => {
  const l = launch(configuration({ "lint.run": "sometimes" }), undefined);
  assert.strictEqual(l.initializationOptions.lint.run, "onType");
});

test("every setting but the trace level restarts the server", () => {
  const declared = Object.keys(pkg.contributes.configuration.properties);
  for (const key of declared) {
    // VS Code reports a change to `q-lint.lint.run` as affecting it and
    // every section above it.
    const affects = (section) => key === section || key.startsWith(`${section}.`);
    assert.strictEqual(needsRestart(affects), key !== "q-lint.trace.server", key);
  }
  assert.strictEqual(needsRestart(() => false), false);
});

test("every declared setting is read", () => {
  // A setting declared but never read does nothing, which is worse than not
  // having it: someone will set it and believe it.
  const read = new Set();
  const spy = {
    get(key, fallback) {
      read.add(key);
      return fallback;
    },
    inspect(key) {
      read.add(key);
      return {};
    },
  };
  launch(spy, undefined);
  for (const key of Object.keys(pkg.contributes.configuration.properties)) {
    const short = key.replace(/^q-lint\./, "");
    // The trace level is read by the language client itself, by its id.
    if (short === "trace.server") continue;
    assert.ok(read.has(short), `${key} is declared but never read`);
  }
});
