# qlinter

A fast linter for q/kdb+ source, written in Rust. It reads q and never runs
it, so it is safe on every keystroke and needs no q, Python or kdb+ licence.
The same binary is a language server (`qlinter --lsp`), and
[editors/vscode](editors/vscode/README.md) is a VS Code extension built on it.

- More than 140 rules, from "q refuses this" to style conventions, each
  explained by `qlinter --explain CODE`.
- Fixes: `--fix` and `--diff` apply the safe ones; `--unsafe-fixes` adds the
  rest.
- Configuration in `qlinter.toml` or `pyproject.toml`, found per file the
  way Ruff finds its own.
- Reports for CI: text, JSON, SARIF and GitHub annotations, baselines, and a
  check against older q versions.
- `qlinter analyze graph`: the file-to-file dependency graph of a q tree.
- A language server: diagnostics, Quick Fixes, navigation, rename, hover,
  completion and more, in any LSP editor.

## Install

Pre-built binaries (Linux, macOS, Windows) are on the
[releases page](https://github.com/kwojdalski/q-lint/releases). Or, with
Rust 1.88 or later:

```sh
cargo install --git https://github.com/kwojdalski/q-lint --tag v0.41.0 --locked
```

The Python distribution `q-lint-rs` and the VS Code `.vsix` are covered in
[docs/install.md](docs/install.md).

## Quick start

```sh
qlinter src/                 # lint a tree
qlinter --diff src/          # preview the safe fixes
qlinter --fix src/           # apply them
qlinter --rules              # every rule
qlinter --explain QF001      # one rule
```

`-` lints standard input. The exit code is 0 with no error or warning, 1 with
findings, and 2 when an input or the configuration failed. The rules are
heuristics over source text: a clean run means no rule matched, which is
weaker than "this code is correct".
[docs/getting-started.md](docs/getting-started.md) walks through a sample
file, its output and its fixes.

Accept a finding on its line with `/ noqa: QF016 reason`, or choose rules
with a profile (`general`, `style`, `styleq`, `uqf`) in `qlinter.toml`:

```toml
profile = "style"
exclude = ["lib/vendor/"]

[lint]
ignore = ["QF016"]
```

## Pre-commit and CI

A [pre-commit](https://pre-commit.com) hook lints the `.q` files a commit
changes:

```yaml
repos:
  - repo: https://github.com/kwojdalski/q-lint
    rev: v0.34.0
    hooks:
      - id: qlinter
```

[docs/ci.md](docs/ci.md) covers the GitHub action (annotations, code
scanning), GitLab, and adopting qlinter on a tree that has findings today.

## Editors

`qlinter --lsp` speaks the Language Server Protocol, reads the same
configuration as the command line, and never connects to anything. The VS
Code extension bundles it and adds q processes, notebooks and more
([README](editors/vscode/README.md)); snippets for Neovim, Helix, Emacs,
Sublime Text, Kakoune and Zed are in [docs/editors.md](docs/editors.md).

## Documentation

[docs/README.md](docs/README.md) indexes every page. The main ones:

- [Getting started](docs/getting-started.md), [Command line](docs/cli.md),
  [Output formats](docs/output.md)
- [Rules](docs/rules.md), [Configuration](docs/configuration.md)
- [CI](docs/ci.md), [Editors](docs/editors.md), [Language server](docs/lsp.md)
- [Design](docs/design.md), [Development](docs/development.md)

## Licence

MIT. See [LICENSE](LICENSE).
