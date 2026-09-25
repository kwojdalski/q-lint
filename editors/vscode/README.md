# q-lint for VS Code

Diagnostics and selected Quick Fixes for q/kdb+ source, as you type, from the
[q-lint](https://github.com/kwojdalski/q-lint) language server.

![the q-lint icon](icon.png)

**The linter never executes the source it reads.** That is what makes it safe
to run on every keystroke, and it is why this extension offers diagnostics,
Quick Fixes and syntax colouring and nothing else: completion, hover and
go-to-definition would need a resolver and a symbol table, and building one
means giving up the guarantee.

Use **Quick Fix** to replace `==` with `=`, `!=` with `<>`, or
`+=`/`-=`/`*=` with `+:`/`-:`/`*:`, and `&&`/`||` with `&`/`|`.
It can also remove a leading UTF-8 BOM, and - with `q-lint.profile` set to
`uqf` - put the brackets back on a call written `f x`, taking in however much
of the line the application swallowed.
Other findings are not changed automatically.

## Syntax colouring

The extension colours q the way VS Code colours Python: a TextMate grammar
tags each span with a standard scope, so whatever colour theme is active
paints it. It picks out comments and qdoc tags (`@param name {type}`,
`@return`, ...), strings and their escapes, symbols and file handles, numbers,
temporals, nulls and booleans, lambdas with their declared parameters and the
implicit `x`, `y` and `z`, names assigned a lambda, other assignments, the
control words and qSQL, the builtins, the `.z`/`.Q`/`.h`/`.j` namespaces,
system commands, block comments and everything after a closing `\`, and
`p)` lines as Python.

The grammar is generated, builtins and all, from the name list the rules use:

```sh
python3 scripts/q_grammar.py > editors/vscode/syntaxes/q.tmLanguage.json
```

## Requirements

None, on a platform this extension is built for. macOS (Apple Silicon and
Intel), Linux x64 and Windows x64 builds carry the matching `qlinter` and run
with nothing installed and nothing configured.

Anywhere else, the extension needs the server: take an archive from
[releases](https://github.com/kwojdalski/q-lint/releases), or build one with
`cargo install --path .` from a clone. Put it on `PATH`, or point
`q-lint.serverPath` at it.

Setting `q-lint.serverPath` always wins, bundled server or not - which is how
to run a build of your own against the extension.

`server/qlinter` is checked in so that packaging the extension from a clone
produces a working vsix without a release build first. It is **darwin-arm64
only** - the one this repository's author builds - and is rebuilt by hand, so
it can lag `src/`. The release workflow ignores it and packages the binary it
just built for each platform. To refresh it:

```sh
cargo build --release && install -m 755 target/release/qlinter editors/vscode/server/qlinter
```

Worth knowing on macOS: an application started from the Dock does not inherit
the `PATH` from your shell profile, so a binary in `~/.local/bin` is invisible
to it even though the same command works in a terminal. The bundled server
sidesteps this; `q-lint.serverPath` with an absolute path is the fix if you
are using your own.

## When a finding looks wrong

Open **Output → q-lint**. The first line names the server version and the
binary it came from, which is usually the answer: the rules live in the
binary, not the extension, so a replaced binary does not take effect until
the server restarts. **q-lint: Restart Server** in the command palette does
that without reloading the window.

## Settings

| setting | default | |
|---|---|---|
| `q-lint.serverPath` | `qlinter` | Path to the binary; looked up on `PATH` as given. |
| `q-lint.profile` | `general` | Rule profile. `uqf` adds that repository's own conventions on top of the general q rules. |
| `q-lint.trace.server` | `off` | Log the traffic between VS Code and the server, for debugging the integration itself. |

## The rules

`qlinter --rules` prints the catalogue and `qlinter --explain <CODE>` prints one
entry. Both read from the linter's own taxonomy, so they are current in a way
this page would not be.

## Troubleshooting

Diagnostics not appearing? Open **Output → q-lint**. The server's own stderr is
forwarded there, so a binary that is missing or refusing its arguments says so
in that panel.
