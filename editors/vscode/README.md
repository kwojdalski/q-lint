# q-lint for VS Code

Diagnostics for q/kdb+ source, as you type, from the
[q-lint](https://github.com/kwojdalski/q-lint) language server.

![the q-lint icon](icon.png)

**The linter never executes the source it reads.** That is what makes it safe
to run on every keystroke, and it is why this extension offers diagnostics and
nothing else: completion, hover and go-to-definition would need a resolver and
a symbol table, and building one means giving up the guarantee.

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

Worth knowing on macOS: an application started from the Dock does not inherit
the `PATH` from your shell profile, so a binary in `~/.local/bin` is invisible
to it even though the same command works in a terminal. The bundled server
sidesteps this; `q-lint.serverPath` with an absolute path is the fix if you
are using your own.

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
