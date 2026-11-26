# qlinter

A linter for q/kdb+ source, written in Rust. It reads q and never runs it,
so it is safe on every keystroke and needs no q, Python or kdb+ licence.

The same binary is a language server (`qlinter --lsp`), and
[editors/vscode](editors/vscode/README.md) is a VS Code extension built on
it.

- More than 140 rules, from "q refuses this" to style conventions, each
  explained by `qlinter --explain CODE`.
- Fixes: `--fix` and `--diff` apply the safe ones; `--unsafe-fixes` adds
  the rest.
- Configuration in `qlinter.toml` or `pyproject.toml`, found per file the
  way Ruff finds its own.
- Reports for CI: text, JSON, SARIF and GitHub annotations, baselines, and a
  check against older q versions.
- `qlinter analyze graph`: the file-to-file dependency graph of a q tree.
- A language server: diagnostics, Quick Fixes, navigation, rename, hover,
  completion and more, in any LSP editor.

## Install

Pre-built binaries for Linux x86-64, macOS (Apple Silicon and Intel) and
Windows x86-64 are on the
[releases page](https://github.com/kwojdalski/q-lint/releases), with a
`SHA256SUMS`. Each archive holds the `qlinter` executable; put it on `PATH`.

With Rust 1.88 or later:

```sh
cargo install --git https://github.com/kwojdalski/q-lint --tag v0.40.0 --locked
```

From a checkout:

```sh
cargo install --path . --locked     # or: cargo build --release
```

The Python distribution `q-lint-rs` wraps the same executable, so a virtual
environment gets `qlinter` with no Rust on the target machine. In a
checkout, `uv sync` builds it and `uv run qlinter src/` runs it.

The VS Code extension is a `.vsix` on the same releases page, one per
platform, with the matching `qlinter` bundled.

## Quick start

```sh
qlinter src/                 # lint a tree
qlinter --diff src/          # preview the safe fixes
qlinter --fix src/           # apply them
qlinter --rules              # every rule
qlinter --explain QF001      # one rule
```

Given this `demo.q`:

```q
eq:{[a;b] a==b}
inc:{[count] count+1}
ok:{x+1} each til 3
```

`qlinter demo.q` prints (the absolute path shortened here):

```text
/work/demo.q:1:12: error: QE004 [syntax/foreign-operator] q has no `==`; the spelling here is `=`
    Operator from another language; q has no ==, !=, &&, ||, **, =>, -> or :=
/work/demo.q:2:5: error: QF001 [names/reserved-parameter] Builtin parameter name(s): ["count"]; q refuses every call to this lambda ('match or 'nyi)
    Builtin name used as a parameter
/work/demo.q:3:4: warning: QR004 [simplification/atomic-each] Arithmetic is atomic: this applies to the whole list without `each`, and faster
    each over one arithmetic operation, which is already atomic
qlinter: 1 file(s), 3 finding(s) (2 errors, 1 warning)
```

`qlinter --fix demo.q` rewrites `a==b` to `a=b`, which cannot change what the
program does. The other two fixes could change behaviour, so they need
`--unsafe-fixes` or a Quick Fix in the editor, and `--fix` says so:

```text
qlinter: 2 finding(s) left have a fix that only --unsafe-fixes applies
```

`-` lints standard input, and `--stdin-filename` names it. The exit code is
0 with no error or warning, 1 with findings, and 2 when an input, the
configuration or qls failed.

## Rules

`qlinter --rules` lists every rule and `qlinter --explain CODE` describes
one. [docs/rules.md](docs/rules.md) is the same catalogue as a page,
generated from `src/taxonomy.json`, with where the rules came from.

A profile picks the rule set:

| profile | reports |
|---|---|
| `general` | only what q refuses to parse or run |
| `style` | `general`, plus q that runs and is probably wrong |
| `styleq` | `style`, plus the published q style guides' conventions |
| `uqf` | every rule a profile turns on |

With no profile set, the command line uses `uqf` and the language server
uses `style`. Narrow the set in the repository's configuration. A few
conventions are in no profile (QP007, QP008) and run only when selected by
their code.

A finding can be accepted on its line with a comment, or for a whole file
with a directive at the left margin:

```q
endofday:{[dt;data] dt} / noqa: QF016 TorQ's fixed signature
/ qlinter: noqa: QS001
```

`qlinter --add-noqa src/` writes that comment for every current finding.
A `noqa` that suppresses nothing is itself reported (QL003).

The rules are heuristics over source text. A clean run means no rule
matched, which is weaker than "this code is correct".

## Command line

`qlinter --help` lists every option. The main ones:

| to | use |
|---|---|
| change the output format | `--format json`, `sarif` or `github` ([docs/output.md](docs/output.md)) |
| count findings per rule | `--statistics` |
| write the report to a file | `--output-file PATH` |
| choose rules | `--profile`, `--select`, `--extend-select`, `--ignore` |
| report only new findings | `--write-baseline FILE` once, then `--baseline FILE` |
| check against an older q | `--target-version 3.6`, `4.0`, `4.1` or `kdbx` |
| see which configuration applies | `--show-settings PATH` |
| add KX's qls as a second backend | `--backend qls` or `--backend all` |

[docs/cli.md](docs/cli.md) covers every option, the full list of fixes,
baselines and the version check.

### The dependency graph

`qlinter analyze graph` prints which q files depend on which, from the
global names each reads and the scripts it loads, as JSON in the shape
`ruff analyze graph` prints. It is meant for test-impact analysis: given
the files that changed, which tests are worth running.

```sh
$ qlinter analyze graph .
{
  "lib/util.q": [],
  "main.q": [
    "lib/util.q"
  ],
  "tests/test_main.q": [
    "main.q"
  ]
}
```

`--direction dependents` turns it round, and `--detail` adds the names
more than one file defines and the places a name is computed at run time.
See [docs/cli.md](docs/cli.md#the-dependency-graph-qlinter-analyze-graph)
for what counts as an edge.

## Configuration

For each file, qlinter walks up from its directory and uses the first
`.qlinter.toml`, `qlinter.toml`, or `pyproject.toml` with a `[tool.qlinter]`
table. One file at the repository root governs everything below it.

```toml
# qlinter.toml
profile = "style"
exclude = ["lib/vendor/", "generated"]
target-version = "4.1"
required-version = ">=0.40"

[lint]
extend-select = ["QS001"]
ignore = ["QF016"]
per-file-ignores = { "tests/*" = ["QS"] }

[severity]
QS = "information"        # reported, but does not fail the run

[rules.QS006]
max-lines = 40
```

Command-line flags win over the file. An unknown key or a selector that
names no rule is an error, not a silent no-op.
[docs/configuration.md](docs/configuration.md) lists every key;
[`editors/vscode/schemas/qlinter.schema.json`](editors/vscode/schemas/qlinter.schema.json)
is the same as a JSON Schema.

## Editors

`qlinter --lsp` speaks the Language Server Protocol on stdin and stdout.
It lints the buffer as you type, offers fixes as Quick Fixes, and answers
outline, go to definition, references, rename, hover, signature help, inlay
hints, folding, call hierarchy and (when enabled) completion, all by reading
the source.
It reads the same configuration files as the command line, so the editor
and CI agree.

- **VS Code**: the extension bundles the server. It also connects to q
  processes you add, to run code, browse results and work in q notebooks;
  the server itself never connects to anything. See
  [its README](editors/vscode/README.md).
- **Neovim, Helix, Emacs, Sublime Text, Kakoune, Zed**: configuration
  snippets in [docs/editors.md](docs/editors.md).
- **Writing a client**: [docs/lsp.md](docs/lsp.md) lists what the server
  implements, its own requests and its `initializationOptions`.

## CI and pre-commit

[docs/ci.md](docs/ci.md) covers GitHub Actions (annotations and code
scanning), GitLab, and adopting qlinter on a tree that has findings today.

A [pre-commit](https://pre-commit.com) hook lints the `.q` files a commit
changes. `qlinter` builds the linter with cargo; `qlinter-system` uses the
one on `PATH`. `rev` is a release tag, v0.34.0 or later:

```yaml
repos:
  - repo: https://github.com/kwojdalski/q-lint
    rev: v0.34.0
    hooks:
      - id: qlinter
```

The GitHub action downloads a release and shows each finding as an
annotation on its line:

```yaml
- uses: actions/checkout@v4
- uses: kwojdalski/q-lint@v0.34.0
  with:
    version: 0.34.0        # the qlinter release to run; required
    paths: src tests       # default: .
    args: --profile style
```

## Building and development

```sh
cargo build --release                          # target/release/qlinter
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

[docs/development.md](docs/development.md) covers the other checks,
packaging with `scripts/dist.py`, and the example files the tests read.
[docs/design.md](docs/design.md) explains why there is no parser and what
that costs.

## Licence

MIT. See [LICENSE](LICENSE).
