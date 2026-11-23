// Restricted Mode (#1164): the extension declares limited support, since the
// linter never runs what it reads, and lists every setting that names a
// program, a command, a file a started q reads its environment from, or the
// language server's arguments - found by asking the code that reads them, so
// a new one cannot be left off. In a workspace that is not trusted its .env
// is not given to q.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { launch } = require("../out/settings.js");
const { readTerminal } = require("../out/liveconfig.js");
const { readEnvSettings } = require("../out/qenv.js");
const { readLauncher } = require("../out/launcher.js");
const { ADMIN_SETTINGS } = require("../out/admin.js");
const { dotenvFor } = require("../out/qenvironment.js");

const capability = pkg.capabilities.untrustedWorkspaces;
const restricted = new Set(capability.restrictedConfigurations);
const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));

/// The keys `read` asks `get` for.
function keysRead(read) {
  const keys = [];
  read((key, fallback) => {
    keys.push(`q-lint.${key}`);
    return fallback;
  });
  return keys;
}

test("the extension supports Restricted Mode in part, and says what is held back", () => {
  assert.strictEqual(capability.supported, "limited");
  assert.match(capability.description, /never runs/);
  for (const key of restricted) {
    assert.ok(props[key], `${key} is restricted but not declared`);
  }
});

test("every setting that becomes the language server's command line is restricted, and no other server setting", () => {
  const server = pkg.contributes.configuration[0].properties;
  const sample = (spec) =>
    spec.type === "boolean" ? !spec.default : spec.type === "array" ? ["--probe"] : spec.type === "object" ? { QS: "hint" } : spec.type === "integer" || spec.type === "number" ? 7 : "probe";
  const configuration = (user) => ({
    get: (key, fallback) => (key in user ? user[key] : (server[`q-lint.${key}`]?.default ?? fallback)),
    inspect: (key) => (key in user ? { globalValue: user[key] } : {}),
  });
  const before = launch(configuration({}), "/ws");
  for (const [key, spec] of Object.entries(server)) {
    const short = key.replace(/^q-lint\./, "");
    const after = launch(configuration({ [short]: sample(spec) }), "/ws");
    const commandLine = after.serverPath !== before.serverPath || JSON.stringify(after.args) !== JSON.stringify(before.args);
    assert.strictEqual(restricted.has(key), commandLine, key);
  }
});

test("every setting naming a program, a command or a q environment file is restricted", () => {
  const programs = [
    ...keysRead(readTerminal),
    ...keysRead(readEnvSettings),
    ...keysRead(readLauncher),
    `q-lint.${ADMIN_SETTINGS.credentialCommand.key}`,
  ];
  assert.deepStrictEqual(programs.sort(), [
    "q-lint.connection.credentialCommand.enable",
    "q-lint.env.enable",
    "q-lint.env.file",
    "q-lint.processes.launcher.enable",
    "q-lint.terminal.envPath",
    "q-lint.terminal.qBinary",
  ]);
  for (const key of programs) {
    assert.ok(restricted.has(key), key);
  }
});

test("a workspace that is not trusted gives q none of its .env", async (t) => {
  stub.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-restricted-"));
  fs.writeFileSync(path.join(dir, ".env"), "QINIT=evil.q\n");
  const workspace = vscode.workspace;
  const saved = { folders: workspace.workspaceFolders, trusted: workspace.isTrusted, fs: workspace.fs, folder: workspace.getWorkspaceFolder };
  const folder = { uri: vscode.Uri.file(dir), name: "ws", index: 0 };
  workspace.workspaceFolders = [folder];
  workspace.getWorkspaceFolder = () => folder;
  workspace.fs = { readFile: async (uri) => fs.promises.readFile(uri.fsPath) };
  t.after(() => {
    workspace.workspaceFolders = saved.folders;
    workspace.isTrusted = saved.trusted;
    workspace.fs = saved.fs;
    workspace.getWorkspaceFolder = saved.folder;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  workspace.isTrusted = true;
  assert.deepStrictEqual(await dotenvFor(folder.uri), { QINIT: "evil.q" });
  workspace.isTrusted = false;
  assert.deepStrictEqual(await dotenvFor(folder.uri), {});
});
