# qlinter — a native q linter

A standalone linter for q/kdb+ source, in Rust. It never executes the code it
reads, which is what makes it safe to run on every keystroke, and the built-in
backend needs neither Python, q, VS Code nor a language server.

It also ships a language server (`--lsp`), so any LSP-speaking editor gets
diagnostics — see [Editor support](#editor-support-the-language-server).

## Install

```sh
cargo install --path . --locked
qlinter src/
```

Or build without installing:

```sh
cargo build --release
./target/release/qlinter src/
./target/release/qlinter src/ --format json
./target/release/qlinter --rules
./target/release/qlinter --explain QF005
```

The executable is independently deployable once built. Compilation uses the
checked-in Cargo lockfile; this version was tested with Rust 1.98.1 on macOS
ARM64.

A Python wheel is also available, for installing the binary into a virtual
environment without Rust on the target machine —
[maturin's binary packaging](https://www.maturin.rs/bindings.html#bin) puts a
real release-mode executable there, with no Python launcher in the way. The
distribution is named `q-lint-rs`; the command is `qlinter`.

```sh
uv sync
uv run qlinter src/
```

## History

This was a port of a Python implementation, which it has since replaced. The
Python version is no longer maintained and is not part of this repository;
[BENCHMARK.md](BENCHMARK.md) keeps the measurements that motivated the
rewrite, because "13-39x faster" is the reason the port exists and is worth
being able to check rather than remember.

## Options

The CLI supports `--profile general|uqf`, `--format text|json`,
`--exclude`, `--config`, stdin (`-`, `--stdin-filename`) and
`--backend builtin|qls|all` options. The default is builtin.
`--qls-executable` chooses the separately installed server;
`--qls-timeout` bounds a batch, plus at most one second for cleanup.
The qls server may itself require Python; the Rust builtin backend does not.

The same `[tool.q-lint]` exclusion configuration in `pyproject.toml` applies:

```toml
[tool.q-lint]
exclude = ["torq/*", "generated/"]
```

Exclusions apply before a file is read or sent to qls. Diagnostics carry a
code and a category; `qlinter --rules` lists them all and `qlinter --explain
QF005` describes one. Exit codes are 0 (no error or warning), 1 (findings) and
2 (input or server failure).

These are heuristics over source text, not a proof: a clean lint means no rule
matched, which is weaker than "this code is correct".
Column-zero `p)`/`k)` blocks and their indented continuations are opaque to
built-in q checks; Python/K syntax is not validated. Normal q analysis resumes
on the next nonblank, unindented q line, and `q)` bodies are checked normally.
The Python-only repository hook's embedded-q-in-Python check is outside the
standalone q analyzers' scope.

## Editor support: the language server

`qlinter --lsp` speaks the Language Server Protocol on stdin/stdout, so any
editor that speaks LSP gets diagnostics with no editor-specific code beyond
"launch this binary".

```sh
qlinter --lsp --profile uqf
```

It implements `initialize`/`initialized`, `didOpen`/`didChange`/`didSave`/
`didClose`, `shutdown`/`exit`, and pushes `textDocument/publishDiagnostics`.
That is the set an editor needs to show squiggles.

**The reason it is a server rather than an editor plugin shelling out to the
CLI**: `didChange` carries the buffer, so what gets linted is what is on
screen, including a file that has never been saved. A CLI over paths cannot do
that, and `--stdin-filename` only gets you there one editor at a time.

Deliberately not implemented: completion, hover, go-to-definition, formatting.
Those need a resolver and a symbol table this crate does not have — it reads
source without executing it, which is what makes it safe to run on every
keystroke. Announcing a capability and answering emptily is worse than not
announcing it, because an editor told that a server provides completion stops
offering its own word-based fallback.

### VS Code

The extension in `editors/vscode` is about thirty lines: it launches the
server and lets the protocol do the rest.

```sh
cargo build --release                      # produces target/release/qlinter
cd editors/vscode && npm install && npm run compile
```

Then either press <kbd>F5</kbd> in that directory to open an Extension
Development Host, or package and install it:

```sh
npx vsce package                           # produces q-lint-0.1.0.vsix
code --install-extension q-lint-0.1.0.vsix
```

Two settings: `q-lint.serverPath` (default `qlinter`, looked up on `PATH` —
point it at `target/release/qlinter` if you have not installed it) and
`q-lint.profile` (`general` or `uqf`).

### Other editors

Neovim, with `nvim-lspconfig`:

```lua
vim.filetype.add({ extension = { q = "q" } })
require("lspconfig.configs").qlint = {
  default_config = {
    cmd = { "qlinter", "--lsp", "--profile", "uqf" },
    filetypes = { "q" },
    root_dir = require("lspconfig.util").root_pattern("pyproject.toml", ".git"),
  },
}
require("lspconfig").qlint.setup({})
```

Helix, in `languages.toml`:

```toml
[language-server.qlint]
command = "qlinter"
args = ["--lsp", "--profile", "uqf"]

[[language]]
name = "q"
file-types = ["q"]
language-servers = ["qlint"]
```

### What the server does not read

`--config` and `--exclude` are not consulted in server mode. An editor asking
for diagnostics on a file it has open has already decided the file is
interesting, and honouring an exclude list there would show a file with no
findings and no explanation for their absence. Exclusions remain a
batch-linting concern, where the question is which files to visit.

## Shipping prebuilt binaries

Build a wheel, standalone executable, archive and SHA-256 checksums for the
current platform:

```sh
uv run python scripts/build_release.py
```

Artifacts go to `dist/` (ignored by Git). The wheel contains the compiled
executable; the standalone archive contains that same executable. Neither needs
Rust/Cargo to run. Installing the wheel needs a Python package installer;
running the standalone binary needs neither Python nor an installer. Optional
`--backend qls` still requires a separately installed qls server.

For example, install a wheel with `uv tool install /path/to/q_lint_rs-....whl`
or `uv pip install /path/to/q_lint_rs-....whl`, then run `qlinter src/`.
Alternatively, unpack the standalone archive and run `./qlinter src/`.

The verified artifacts in this checkout target **macOS 11+ on Apple Silicon**.
Build on each target OS/architecture to distribute its matching binary; this
command does not cross-compile. It builds artifacts locally and does not publish
them to PyPI or a release service.

## Validation and profiling

```sh
cargo test                                            # unit, CLI and LSP suites
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo build --release                                 # the Python harness needs it
Q_LINT_TEST_QLS=qls uv run pytest tests                # black-box CLI checks
cargo build --release --example profile               # for profiling the analysis API
```

The Rust tests cover the rule engine, the CLI's black-box behaviour and the
language server driven over real LSP framing as a real process. The parity
harness that used to check this implementation against the Python one is gone
with it; what it protected is now covered by `tests/core.rs`.

