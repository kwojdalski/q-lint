// The q dev container template (#977): the files are valid and hold no
// secret, the install script parses and, without the secrets, says what to
// set and installs nothing; the command previews, writes only on Write,
// never over a file, and refuses while off - through the stand-in `vscode`
// module over a real temporary folder.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pkg = require("../package.json");
const D = require("../out/devcontainer.js");
const { addDevContainer, registerDevContainer } = require("../out/devcontainerview.js");

test("the template: a devcontainer.json naming the secrets it never holds, and an install script that parses", () => {
  const files = D.templateFiles();
  assert.deepStrictEqual(files.map((f) => f.path), [".devcontainer/devcontainer.json", ".devcontainer/install-kdbx.sh"]);
  const json = JSON.parse(files[0].content);
  assert.deepStrictEqual(Object.keys(json.secrets), ["KX_DOWNLOAD_TOKEN", "KDB_LICENSE_B64"]);
  assert.strictEqual(json.postCreateCommand, "bash .devcontainer/install-kdbx.sh");
  assert.deepStrictEqual(json.customizations.vscode.extensions, [`${pkg.publisher}.${pkg.name}`]);
  assert.strictEqual(json.customizations.vscode.settings["q-lint.terminal.qBinary"], "~/.kx/bin/q");
  assert.ok(!("containerEnv" in json) && !("remoteEnv" in json), "no secret is baked into the container");
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dc-")), "install-kdbx.sh");
  fs.writeFileSync(script, files[1].content);
  assert.strictEqual(spawnSync("bash", ["-n", script]).status, 0, "bash parses it");
  assert.doesNotMatch(files[1].content, /set -x|echo "?\$KX_DOWNLOAD_TOKEN|echo "?\$KDB_LICENSE/, "never prints a secret");
  assert.match(files[1].content, /--oauth2-bearer "\$KX_DOWNLOAD_TOKEN"/);
  assert.match(files[1].content, /install_kdb\.sh --b64lic "\$KDB_LICENSE_B64"/);
});

test("without the secrets the script installs nothing, says what to set, and the container still starts", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dchome-"));
  const script = path.join(home, "install-kdbx.sh");
  fs.writeFileSync(script, D.templateFiles()[1].content);
  const r = spawnSync("bash", [script], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /KDB-X was not installed: KX_DOWNLOAD_TOKEN and KDB_LICENSE_B64/);
  assert.strictEqual(fs.existsSync(path.join(home, ".kx")), false);
  // Already installed: left alone.
  fs.mkdirSync(path.join(home, ".kx", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".kx", "bin", "q"), "#!/bin/sh\n");
  fs.chmodSync(path.join(home, ".kx", "bin", "q"), 0o755);
  const again = spawnSync("bash", [script], { env: { HOME: home, PATH: "/usr/bin:/bin", KX_DOWNLOAD_TOKEN: "t", KDB_LICENSE_B64: "l" }, encoding: "utf8" });
  assert.strictEqual(again.status, 0);
  assert.match(again.stdout, /already installed/);
});

test("the plan never writes over a file, and the preview shows what would be written", () => {
  const files = D.templateFiles();
  const planned = D.plan(files, (p) => p.endsWith(".json"));
  assert.deepStrictEqual(planned.write.map((f) => f.path), [".devcontainer/install-kdbx.sh"]);
  assert.deepStrictEqual(planned.skip, [".devcontainer/devcontainer.json"]);
  const preview = D.previewText("repo", planned);
  assert.match(preview, /`\.devcontainer\/devcontainer\.json` is already there and is left as it is/);
  assert.match(preview, /## \.devcontainer\/install-kdbx\.sh\n\n```bash\n#!\/usr\/bin\/env bash/);
  assert.match(preview, /Nothing is written until you choose \*\*Write\*\*/);
});

/// The stand-in over `dir`: a real file system, previews and dialogs kept.
function setUp(t, dir) {
  stub.reset();
  const previews = [];
  const dialogs = [];
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: path.basename(dir), index: 0 }];
  vscode.workspace.fs = {
    stat: async (uri) => fs.statSync(uri.fsPath),
    createDirectory: async (uri) => void fs.mkdirSync(uri.fsPath, { recursive: true }),
    writeFile: async (uri, data) => void fs.writeFileSync(uri.fsPath, data),
    readDirectory: async (uri) => fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File]),
  };
  vscode.workspace.openTextDocument = async (options) => (previews.push(options), options);
  vscode.window.showTextDocument = async () => {};
  const info = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (text, ...rest) => {
    if (typeof rest[0] === "object" && rest[0]?.modal) {
      dialogs.push(text);
      return stub.picks.shift();
    }
    return info(text, ...rest);
  };
  const context = stub.newContext();
  registerDevContainer(context);
  t.after(() => {
    vscode.window.showInformationMessage = info;
    vscode.workspace.workspaceFolders = undefined;
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { previews, dialogs };
}

test("the command previews first, writes nothing on Cancel, and on Write only the files not there", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dcws-"));
  const { previews, dialogs } = setUp(t, dir);
  stub.picks.push(undefined); // Cancel
  assert.deepStrictEqual(await stub.commands.get(D.DEVCONTAINER_COMMAND)(), []);
  assert.strictEqual(previews.length, 1);
  assert.strictEqual(previews[0].language, "markdown");
  assert.match(dialogs[0], /^Write \.devcontainer\/devcontainer\.json and \.devcontainer\/install-kdbx\.sh into /);
  assert.strictEqual(fs.existsSync(path.join(dir, ".devcontainer")), false, "nothing written");
  // One file already there: left, and only the other written.
  fs.mkdirSync(path.join(dir, ".devcontainer"));
  fs.writeFileSync(path.join(dir, ".devcontainer", "devcontainer.json"), "{ \"mine\": true }\n");
  stub.picks.push("Write");
  assert.deepStrictEqual(await addDevContainer(), [".devcontainer/install-kdbx.sh"]);
  assert.match(dialogs[1], /devcontainer\.json is already there and left as it is/);
  assert.strictEqual(fs.readFileSync(path.join(dir, ".devcontainer", "devcontainer.json"), "utf8"), "{ \"mine\": true }\n");
  assert.strictEqual(fs.readFileSync(path.join(dir, ".devcontainer", "install-kdbx.sh"), "utf8"), D.templateFiles()[1].content);
  // Both there: nothing to write, no dialog.
  assert.deepStrictEqual(await addDevContainer(), []);
  assert.strictEqual(dialogs.length, 2);
  assert.match(stub.messages.at(-1)[1], /already has .*nothing was written/);
});

// A root .devcontainer.json was shadowed by the template's
// .devcontainer/devcontainer.json, which Dev Containers read first (#1532).
test("a repository with a dev container configuration elsewhere gets nothing written", async (t) => {
  for (const where of [".devcontainer.json", ".devcontainer/py/devcontainer.json"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dcother-"));
    fs.mkdirSync(path.dirname(path.join(dir, where)), { recursive: true });
    fs.writeFileSync(path.join(dir, where), "{}\n");
    const { dialogs } = setUp(t, dir);
    stub.picks.push("Write");
    assert.deepStrictEqual(await addDevContainer(), []);
    assert.strictEqual(dialogs.length, 0);
    assert.ok(stub.messages.at(-1)[1].includes(`has a dev container configuration already, ${where}; nothing was written`));
    assert.strictEqual(fs.existsSync(path.join(dir, ".devcontainer", "install-kdbx.sh")), false);
    stub.picks.length = 0;
  }
});

// The second file failing escaped as a raw error, the first left written
// unsaid (#1536).
test("a file that cannot be written is said, with what was written before it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dcfail-"));
  setUp(t, dir);
  const write = vscode.workspace.fs.writeFile;
  vscode.workspace.fs.writeFile = async (uri, data) => {
    if (uri.fsPath.endsWith(".sh")) throw new Error("EROFS: read-only file system");
    return write(uri, data);
  };
  stub.picks.push("Write");
  assert.deepStrictEqual(await addDevContainer(), [".devcontainer/devcontainer.json"]);
  assert.match(stub.messages.at(-1)[1], /^q-lint: could not write .*install-kdbx\.sh: EROFS: read-only file system\. \.devcontainer\/devcontainer\.json was written\.$/);
});

test("off: the command is hidden, refuses, and writes nothing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dcoff-"));
  const { previews } = setUp(t, dir);
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.devContainer.enable"].default, true);
  const entry = pkg.contributes.menus.commandPalette.find((m) => m.command === D.DEVCONTAINER_COMMAND);
  assert.match(entry.when, /config\.q-lint\.devContainer\.enable/);
  stub.config.user["devContainer.enable"] = false;
  stub.picks.push("Write");
  assert.deepStrictEqual(await stub.commands.get(D.DEVCONTAINER_COMMAND)(), []);
  assert.match(stub.messages.at(-1)[1], /dev container template is turned off\. Set q-lint\.devContainer\.enable to true/);
  assert.strictEqual(previews.length, 0);
  assert.strictEqual(fs.existsSync(path.join(dir, ".devcontainer")), false);
});
