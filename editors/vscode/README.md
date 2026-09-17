# q-lint for VS Code

Diagnostics for q/kdb+ source, as you type, from the
[q-lint](https://github.com/kwojdalski/q-lint) language server.

![the q-lint icon](icon.png)

**The linter never executes the source it reads.** That is what makes it safe
to run on every keystroke, and it is why this extension offers diagnostics and
nothing else: completion, hover and go-to-definition would need a resolver and
a symbol table, and building one means giving up the guarantee.

## Requirements

The extension is the client only - it needs the `qlinter` binary.

```sh
cargo install --path .    # from a clone of the repository
```

If `qlinter` is not on your `PATH`, point `q-lint.serverPath` at it. A release
build leaves it in `target/release/qlinter`.

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
