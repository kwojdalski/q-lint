# qlinter

A standalone linter for q/kdb+ source, in Rust, plus a language server and a
VS Code client for it.

## The property the whole design rests on

**This tool never executes the source it reads.** That is what makes it safe
to run on every keystroke in an editor, and it is the reason several
capabilities are absent rather than merely unimplemented: completion, hover
and go-to-definition need a resolver and a symbol table, and building one
would mean giving up the guarantee. A change that would require evaluating
input is a change to the premise, not a feature.

## Verify with

```sh
cargo test                                  # unit, CLI and LSP suites
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The LSP suite spawns the real binary and drives it over real protocol
framing, because the two things most likely to break an editor integration -
the wire framing and the process not exiting - only exist once there is a
process.

## Where things are

| | |
|---|---|
| `src/lib.rs` | the rule engine; `lint(source, path, uqf)` is the entry point |
| `src/semantics.rs` | the checks that need more than a regex |
| `src/taxonomy.json`, `src/reserved.json` | rule catalogue and q builtin names, embedded at build time |
| `src/lsp.rs` | the language server (`qlinter --lsp`) |
| `src/jsonrpc.rs` | LSP wire framing, shared by the server and the qls client |
| `src/qls.rs` | client for KX's qls, an optional second backend |
| `editors/vscode` | the VS Code extension, ~30 lines over `vscode-languageclient` |

## Two rules worth stating

- **A rule's description lives in `src/taxonomy.json`**, which `--rules` and
  `--explain` print from. Prose that repeats it is a second place to be wrong.
- **`--profile uqf` encodes another repository's conventions.** It is a
  named profile rather than the default for that reason; the default is
  `general`, and a rule that only makes sense for one codebase belongs behind
  a profile rather than in the general set.
