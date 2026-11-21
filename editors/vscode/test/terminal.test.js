// The q terminal (#856): the command line that starts q in each shell, the
// env file, code made into lines q's console reads, and the keys and
// settings package.json declares for it. Run after `tsc`; nothing here needs
// an editor or a q.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const pkg = require("../package.json");
const { commandLine, parseEnv, quote, replLine, replLines, shellKind } = require("../out/terminal.js");
const { COMMANDS, readTerminal } = require("../out/liveconfig.js");
const { needsRestart } = require("../out/settings.js");

test("the shell is read from its path", () => {
  assert.strictEqual(shellKind("/bin/zsh"), "posix");
  assert.strictEqual(shellKind("/usr/bin/bash"), "posix");
  assert.strictEqual(shellKind("C:\\Program Files\\Git\\bin\\bash.exe"), "posix");
  assert.strictEqual(shellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell");
  assert.strictEqual(shellKind("/usr/local/bin/pwsh"), "powershell");
  assert.strictEqual(shellKind("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.strictEqual(shellKind(undefined), "posix");
});

test("a plain word is passed as it is", () => {
  for (const shell of ["posix", "powershell", "cmd"]) {
    assert.strictEqual(quote("q", shell), "q");
    assert.strictEqual(quote("src/main.q", shell), "src/main.q");
  }
  assert.strictEqual(quote("C:\\q\\w64\\q.exe", "cmd"), "C:\\q\\w64\\q.exe");
  assert.strictEqual(quote("C:\\q\\w64\\q.exe", "powershell"), "C:\\q\\w64\\q.exe");
  // A backslash is an escape to a POSIX shell.
  assert.strictEqual(quote("a\\b.q", "posix"), "'a\\b.q'");
});

test("a POSIX shell gets single quotes, with a quote closed, escaped and reopened", () => {
  assert.strictEqual(quote("my file.q", "posix"), "'my file.q'");
  assert.strictEqual(quote("it's.q", "posix"), "'it'\\''s.q'");
  assert.strictEqual(quote('say "hi" $HOME `x`.q', "posix"), "'say \"hi\" $HOME `x`.q'");
  assert.strictEqual(quote("", "posix"), "''");
});

test("a POSIX word or value that starts with = is quoted, as zsh expands =name to a path", () => {
  assert.strictEqual(quote("=x", "posix"), "'=x'");
  assert.strictEqual(quote("a=b", "posix"), "a=b");
  assert.strictEqual(commandLine("q", ["=x"], "posix", { QINIT: "=init.q" }), "QINIT='=init.q' q '=x'");
  // What zsh itself makes of them, where there is one.
  const zsh = spawnSync("zsh", ["-f", "-c", `printf '%s\\n' ${quote("=x", "posix")}; ${commandLine("printenv", ["QINIT"], "posix", { QINIT: "=init.q" })}`], {
    encoding: "utf8",
  });
  if (zsh.error === undefined) {
    assert.deepStrictEqual([zsh.stdout, zsh.stderr], ["=x\n=init.q\n", ""]);
  }
});

test("PowerShell gets single quotes with a quote doubled, and & before a quoted command", () => {
  assert.strictEqual(quote("my file.q", "powershell"), "'my file.q'");
  assert.strictEqual(quote("it's.q", "powershell"), "'it''s.q'");
  assert.strictEqual(quote("it\u2019s.q", "powershell"), "'it\u2019\u2019s.q'");
  assert.strictEqual(quote("$env:x.q", "powershell"), "'$env:x.q'");
  assert.strictEqual(quote("a,b.q", "powershell"), "'a,b.q'");
  assert.strictEqual(
    commandLine("C:\\Program Files\\q\\q.exe", ["my file.q"], "powershell"),
    "& 'C:\\Program Files\\q\\q.exe' 'my file.q'",
  );
  assert.strictEqual(commandLine("q", ["my file.q"], "powershell"), "q 'my file.q'");
});

test("cmd gets double quotes, split as a C runtime splits them", () => {
  assert.strictEqual(quote("my file.q", "cmd"), '"my file.q"');
  // Backslashes before a quote, and before the closing one, are doubled.
  assert.strictEqual(quote('a"b', "cmd"), '"a\\"b"');
  assert.strictEqual(quote('a\\"b', "cmd"), '"a\\\\\\"b"');
  assert.strictEqual(quote("C:\\my dir\\", "cmd"), '"C:\\my dir\\\\"');
  assert.strictEqual(quote("C:\\my dir\\x.q", "cmd"), '"C:\\my dir\\x.q"');
  assert.strictEqual(
    commandLine("C:\\Program Files\\q\\q.exe", ["my file.q"], "cmd"),
    '"C:\\Program Files\\q\\q.exe" "my file.q"',
  );
});

test("a command line is the binary and its arguments", () => {
  assert.strictEqual(commandLine("q", [], "posix"), "q");
  assert.strictEqual(commandLine("q", ["main.q"], "posix"), "q main.q");
  assert.strictEqual(commandLine("/opt/my q/q", ["src/my file.q"], "posix"), "'/opt/my q/q' 'src/my file.q'");
});

test("the env file's variables are set on the command line, for each shell", () => {
  const env = { QHOME: "/opt/q", QINIT: "it's here.q" };
  assert.strictEqual(commandLine("q", ["main.q"], "posix", env), "QHOME=/opt/q QINIT='it'\\''s here.q' q main.q");
  assert.strictEqual(
    commandLine("C:\\my q\\q.exe", [], "powershell", env),
    "$env:QHOME='/opt/q'; $env:QINIT='it''s here.q'; & 'C:\\my q\\q.exe'",
  );
  assert.strictEqual(commandLine("q", ["main.q"], "cmd", env), 'set "QHOME=/opt/q" && set "QINIT=it\'s here.q" && q main.q');
  assert.strictEqual(commandLine("q", [], "posix", {}), "q");
});

test("an env file is NAME=value lines, taken as written", () => {
  const { env, problems } = parseEnv(
    [
      "# kdb+",
      "QHOME=/opt/q",
      "export QLIC = /opt/lic ",
      "",
      'QINIT="/opt/init file.q"',
      "SINGLE='a b'",
      "PATHS=$HOME/q:/opt/q",
      "EMPTY=",
      "EQ=a=b",
      "not a line",
      "1BAD=x",
    ].join("\r\n"),
  );
  assert.deepStrictEqual(env, {
    QHOME: "/opt/q",
    QLIC: "/opt/lic",
    QINIT: "/opt/init file.q",
    SINGLE: "a b",
    PATHS: "$HOME/q:/opt/q",
    EMPTY: "",
    EQ: "a=b",
  });
  assert.deepStrictEqual(problems, ["line 10: not NAME=value: not a line", "line 11: not NAME=value: 1BAD=x"]);
});

test("a statement's continuation lines join the first with a space", () => {
  assert.deepStrictEqual(replLines("a:1\nf:{[x]\n  y:x+1;\n  y*2}\nf 3"), ["a:1", "f:{[x] y:x+1; y*2}", "f 3"]);
  assert.deepStrictEqual(replLines("t:([]\n\ta:1 2;\n\tb:3 4)"), ["t:([] a:1 2; b:3 4)"]);
});

test("a trailing comment is cut, and a comment line inside a lambda dropped", () => {
  assert.strictEqual(replLine("g:{[x] x+1; / one more\n  x*2}"), "g:{[x] x+1; x*2}");
  assert.strictEqual(replLine("h:{\n  / inner\n  x+1}"), "h:{ x+1}");
  assert.strictEqual(replLine("a:1 / one"), "a:1");
  // `/` with no space before it is an operator, and inside a string text.
  assert.strictEqual(replLine("s:+/[1 2]"), "s:+/[1 2]");
  assert.strictEqual(replLine('p:" / not a comment";\n  q:1'), 'p:" / not a comment"; q:1');
  assert.strictEqual(replLine('e:"say \\" / still in";\n  1'), 'e:"say \\" / still in"; 1');
});

test("a string that runs onto the next line keeps its newline as \\n", () => {
  assert.strictEqual(replLine('s:"ab\n  cd"'), 's:"ab\\n  cd"');
  assert.strictEqual(replLine('s:("ab\n  cd";\n  1)'), 's:("ab\\n  cd"; 1)');
});

test("a system command is sent as it is, and comments and \\ follow the query rules", () => {
  assert.deepStrictEqual(replLines("\\d .lib\nadd:{x+y}\n\\cd /tmp\n\\d ."), ["\\d .lib", "add:{x+y}", "\\cd /tmp", "\\d ."]);
  // `/` alone opens a block comment that `\` alone closes; `\` alone outside
  // one ends the script, where it would switch q's console to k.
  assert.deepStrictEqual(replLines("/ a comment\na:1\n/\nb:2\n\\\nc:3"), ["a:1", "c:3"]);
  assert.deepStrictEqual(replLines("a:1\n\\\nb:2"), ["a:1"]);
  assert.deepStrictEqual(replLines("/ only\n\n"), []);
});

test("the terminal keys are ctrl+shift+q, ctrl+shift+r and ctrl+shift+e in a q editor", () => {
  const keys = Object.fromEntries(pkg.contributes.keybindings.map((k) => [k.command, k]));
  assert.strictEqual(keys[COMMANDS.sendLine].key, "ctrl+shift+q");
  assert.strictEqual(keys[COMMANDS.sendSelection].key, "ctrl+shift+r");
  assert.strictEqual(keys[COMMANDS.sendBlock].key, "ctrl+shift+e");
  for (const command of [COMMANDS.sendLine, COMMANDS.sendSelection, COMMANDS.sendBlock]) {
    assert.strictEqual(keys[command].when, "editorTextFocus && editorLangId == q");
  }
});

test("every terminal setting is read, with the default package.json declares, and none restarts the server", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: terminal");
  const declared = section.properties;
  const read = new Map();
  const settings = readTerminal((key, fallback) => {
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
  assert.deepStrictEqual(settings, { qBinary: "q", envPath: "" });
  // An empty binary falls back to q.
  assert.strictEqual(readTerminal((key, fallback) => (key === "terminal.qBinary" ? "  " : fallback)).qBinary, "q");
});

test("a leading ~ in a q binary or env file setting is the home directory", () => {
  const { expandHome } = require("../out/terminal.js");
  assert.strictEqual(expandHome("~/q/m64/q", "/Users/me"), "/Users/me/q/m64/q");
  assert.strictEqual(expandHome("~", "/Users/me"), "/Users/me");
  assert.strictEqual(expandHome("~\\q\\w64\\q.exe", "C:\\Users\\me"), "C:\\Users\\me\\q\\w64\\q.exe");
  // Another user's home, a ~ inside a path, and a plain name are left alone.
  assert.strictEqual(expandHome("~bob/q", "/Users/me"), "~bob/q");
  assert.strictEqual(expandHome("/opt/~/q", "/Users/me"), "/opt/~/q");
  assert.strictEqual(expandHome("q", "/Users/me"), "q");
});

test("a terminal setting of the wrong type, as settings.json allows, is its default instead of failing every terminal", () => {
  const read = (values) => () => readTerminal((key, fallback) => (key in values ? values[key] : fallback));
  assert.doesNotThrow(read({ "terminal.qBinary": null, "terminal.envPath": 7 }));
  assert.deepStrictEqual(read({ "terminal.qBinary": null, "terminal.envPath": 7 })(), { qBinary: "q", envPath: "" });
  assert.deepStrictEqual(read({ "terminal.qBinary": ["q"], "terminal.envPath": null })(), { qBinary: "q", envPath: "" });
});
