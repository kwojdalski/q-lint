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

## The rules

[docs/rules.md](docs/rules.md) lists every rule, what it reports, and which
profile turns it on - generated from the same taxonomy `qlinter --rules` prints
from, so the two cannot disagree. It also says where the rules came from: q
itself for everything in the default set, the hazards behind another linter's
rules for most of `style`, and the published q style guides for `styleq`.

The default profile is the broadest. This binary reports everything it can
see; narrowing belongs in the configuration of the repository being linted.

## Design

There is no parser here. Rules read a masked view of the source - strings and
comments blanked in place, offsets preserved - and take structure locally
where they need it. [docs/design.md](docs/design.md) sets out why, and what
the approach costs.

[docs/ruff-applicability.md](docs/ruff-applicability.md) asks what a mature
linter for another language checks, and how little of it means anything in q -
with [docs/ruff-rules.md](docs/ruff-rules.md) as the reference.

## Options

Text output is coloured on a terminal - red for an error, yellow for a
warning, with a tally on the summary line - and plain everywhere else: a pipe,
a file, or anywhere `NO_COLOR` is set. `--color always|never` overrides the
guess in either direction. JSON output never carries colour.

`qlinter --version` (or `-v`) reports the build, and `--stdio` is accepted and ignored
so a client that appends it gets a server rather than an exit code.

The CLI supports `--profile general|style|styleq|uqf`, `--format text|json`,
`--exclude`, `--config`, stdin (`-`, `--stdin-filename`) and
`--backend builtin|qls|all` options. The default is builtin.
`--qls-executable` chooses the separately installed server;
`--qls-timeout` bounds a batch, plus at most one second for cleanup.
The qls server may itself require Python; the Rust builtin backend does not.

To preview mechanical edits, run `qlinter --diff path/to/file.q`; to write
them, run `qlinter --fix path/to/file.q`. `--fix` re-lints the changed files and
reports any remaining findings. Batch fixing handles `==`, `!=`, `+=`, `-=`,
`*=`, a leading UTF-8 BOM, an invalid string escape (`"C:\data"` →
`"C:\\data"`), `true`/`false`/`None`/`return x` → `1b`/`0b`/`(::)`/`:x`,
a table literal of scalars (each column enlisted), a symbol used as a `like`
pattern (`` `a* `` → `"a*"`), a string compared with `=` in a filter →
`like`, `f . ()` → `f[]`, `til 5.0` → `til 5` (and `2.0 rotate`, `3.0 mavg`),
a number signalled → a string, `where a:1` → `where a=1`, `{x} each y` → `y`, `distinct asc distinct` → `asc distinct`,
redundant parentheses around one token (styleq), and - under `--profile uqf` -
parentheses showing the order q already evaluates `a*b+c` in, and the
brackets QP006 asks for, rewriting `f x` as `f[x]` with whatever the
application swallowed. Each was checked in q 5 to leave the program alone, or
to replace code that could only fail.

Some rewrites change behaviour or guess at intent, so they remain editor Quick
Fixes that you choose individually: `&&` → `&`, `||` → `|`, `reverse asc` →
`desc` (they differ on a dictionary's tied keys), a symbol given to
`ss`/`ssr` → a string, dropping a lambda's trailing `;` so it returns its last
value, `a -1` → `a - 1`, `=` against a vector in a filter → `in`, `f(a;b)` →
`f[a;b]`, `` `int$"12" `` → `"I"$"12"`, removing a statement that never runs,
removing an unused local's name while keeping its expression,
`{x+1} each a` → `a+1` (they differ on an empty typed list), parentheses
round each comparison an `and`/`or` swallows in a where phrase, `~` → `=` in
a filter, `x` → the one declared parameter, deleting a commented-out
definition, passing an outer local into a nested lambda that reads it
(`{a+x}` → `{[a;x] a+x}[a]`), dropping the trailing `;` of `$[c;a;b;]`,
`$[c;a]` → `if[c;a]`, `10/2` → `10%2`, removing `a:a`, renaming a parameter
that shadows a builtin, a column one typo from the table's, and (uqf)
`.z.P` → `.z.p` and datetime → timestamp. Add
`--unsafe-fixes` - Ruff's flag of the same name - to have `--diff` and `--fix`
include them. Both CLI options use the builtin backend (or `--backend all`);
`--fix` requires file paths rather than stdin.

One pass leaves whatever it could not delimit. A call inside a qSQL phrase is
not rewritten at all, because `from`, `by` and `where` end an expression there
and this tool does not parse; and where one juxtaposed call is the argument of
another, the outer one is bracketed and the inner waits for the next pass.
Both keep their finding, so nothing is silently dropped.

### Configuration

Settings are found the way Ruff finds its own. For each file, qlinter walks up
from the file's directory and uses the first of `.qlinter.toml`,
`qlinter.toml`, or a `pyproject.toml` with a `[tool.qlinter]` table (the older
`[tool.q-lint]` still works). A `pyproject.toml` without the table is passed
over, so a Python package's own one does not hide the repository's. Put one
file at the repository root and it governs everything beneath it, wherever
qlinter is run from; a sub-project can carry its own, and the nearest wins.
Where no directory has one, `~/.config/qlinter/qlinter.toml` (or
`$XDG_CONFIG_HOME/qlinter/`) applies.

```toml
# qlinter.toml at the repository root
profile = "style"                    # general | style | styleq | uqf
exclude = ["lib/torq/", "generated"] # relative to this file; a bare name matches anywhere

[lint]
select = ["QE", "QF", "QT"]          # codes or prefixes; replaces the profile's set
extend-select = ["QS001"]            # added to whatever is selected
ignore = ["QF016"]
per-file-ignores = { "tests/*" = ["QS"] }
```

In `pyproject.toml` the same keys go under `[tool.qlinter]`, and
`[tool.qlinter.lint]`. Also: `extend-exclude`, and `extend = "../qlinter.toml"`
to inherit another file and override it. As in Ruff, the most specific
selector wins - `ignore = ["QS"]` with `extend-select = ["QS001"]` keeps QS001
alone - and a selector that names no rule is refused, so a typo cannot quietly
select or ignore nothing.

The command line wins over the file: `--profile`, then `--select`,
`--extend-select` and `--ignore` (comma-separated or repeated) applied after
it, and `--exclude` added to it. `--config FILE` uses one file for everything,
`--isolated` ignores them all, and `--show-settings PATH` prints which file
governs a path and the rules it turns on. Exclusions apply before a file is
read or sent to qls; the rest decide which findings are reported, fixed by
`--fix` and `--diff`, and shown by the language server, which finds each open
document's settings the same way and re-reads them when one changes.

Diagnostics carry a
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
It also offers Quick Fixes through `textDocument/codeAction` for `==` → `=`,
`!=` → `<>`, `+=`/`-=`/`*=` → `+:`/`-:`/`*:`, and a leading UTF-8 BOM.
It also fixes `&&` → `&` and `||` → `|` when selected in the editor, and
`f x` → `f[x]` for QP006 under the uqf profile - where the edit covers the
whole application, not just the underlined name - along with every other
fix `--fix` and the editor-only list above describe.
Other findings remain diagnostic-only.

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
npx vsce package                           # produces q-lint-0.2.0.vsix
code --install-extension q-lint-0.2.0.vsix
```

Two settings: `q-lint.serverPath` (default `qlinter`, looked up on `PATH` —
point it at `target/release/qlinter` if you have not installed it) and
`q-lint.profile` (`general`, `style`, `styleq` or `uqf`). Set, it overrides the
repository's `profile`; unset, the repository's configuration decides, and
`style` - what q refuses, and what q runs that is almost certainly a mistake -
applies where there is none. `qlinter --lsp` without `--profile` defaults to
`style` too.

### Other editors

Neovim, with `nvim-lspconfig`:

```lua
vim.filetype.add({ extension = { q = "q" } })
require("lspconfig.configs").qlint = {
  default_config = {
    cmd = { "qlinter", "--lsp", "--profile", "uqf" },
    filetypes = { "q" },
    root_dir = require("lspconfig.util").root_pattern("qlinter.toml", ".qlinter.toml", "pyproject.toml", ".git"),
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

## Builds, downloads and installing

Every artifact - built here or downloaded from a release - goes to `dist/`
(ignored by Git), one folder per version, named as the GitHub release names
them:

```sh
python3 scripts/dist.py build              # this checkout -> dist/vX.Y.Z/ (or vX.Y.Z-dev/)
python3 scripts/dist.py build --wheel      # ...plus the Python wheel (needs uv)
python3 scripts/dist.py download 0.14.9    # a release, this machine's files -> dist/v0.14.9/
python3 scripts/dist.py download 0.14.9 --all-platforms
python3 scripts/dist.py install            # build, then install the CLI and VS Code extension
python3 scripts/dist.py install 0.14.9     # install a release, downloading it if needed
```

`build` makes the command-line archive and the VS Code extension for the
machine it runs on - it does not cross-compile; the release workflow builds
every platform. A build of anything but a clean checkout of the tag `vX.Y.Z`
lands in `dist/vX.Y.Z-dev/`, so it is never mistaken for the release. Each
folder carries a `SHA256SUMS`. `install` puts `qlinter` in `~/.local/bin`
(`--bin-dir` to change it) and the extension into VS Code; reload the window
afterwards. Neither the archive nor the wheel needs Rust or Python to run, and
`--backend qls` still needs a separately installed qls.

A release is a tag: `python3 scripts/dist.py bump X.Y.Z` sets the version in
`Cargo.toml`, `Cargo.lock`, `pyproject.toml` and the extension, and refreshes
its bundled server; commit, tag `vX.Y.Z` and push, and the release workflow
builds and publishes every platform.

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
language server driven over real LSP framing as a real process.


### Rule and multiline regression corpus

The taxonomy contains 88 codes. Ten literal-call rules cover excess builtin
arguments (QA010), invalid literal types/shapes (QT008–QT014), and negative
`til`/`where` counts (QD001–QD002). These checks leave unknown expressions
unresolved and account for projections, seeded scans and variadic `enlist`.

`examples/showcase.q` marks each expected diagnostic with `expect-next`.
`tests/showcase.rs` checks exact code/line pairs under every profile, including
silence in the clean section. Together with the two companion examples it
covers all 86 rules available in this build; QF006 and QLS001 are excluded.

Multiline fixtures cover nested lambdas, split argument lists, comments,
scalar-only tables, dictionary lengths and assignment from control statements.
With q on PATH, `tests/test_intrinsic_runtime.py` runs only curated fixture
expressions in a separate q process and compares runtime failures and valid
counterparts with the linter. This is an optional development oracle; linting
itself never executes input. Build the release binary before running it:

```sh
cargo build --release
uv run --with pytest pytest tests/test_intrinsic_runtime.py
```
