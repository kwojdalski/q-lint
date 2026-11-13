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

To preview mechanical edits, run `qlinter --diff path/to/file.q` - a unified
diff with paths relative to the current directory, which `patch -p1` and
`git apply` take as it is; to write them, run `qlinter --fix path/to/file.q`.
`--fix` re-lints the changed files and reports any remaining findings. Batch fixing handles `==`, `!=`, `+=`, `-=`,
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

### The dependency graph: `qlinter analyze graph`

```sh
qlinter analyze graph src/                          # {file: [files it depends on]}
qlinter analyze graph --direction dependents src/   # {file: [files that depend on it]}
qlinter analyze graph --detail src/                 # {file: {dependencies, ambiguous, dynamic}}
```

Prints the file-to-file dependency graph of the q files under the paths, as
JSON in the shape `ruff analyze graph` prints: every file is a key, even one
with no edges, keys and lists are sorted so two runs print the same bytes,
and paths are relative to the current directory. It is built for test-impact
analysis - from the files that changed, which tests are worth running - and,
like the rest of qlinter, it reads the files and runs none of them.

A file depends on another when:

- it reads a global name the other defines. A bare name is qualified by the
  `\d` context in force and by nothing else, as q resolves it: `f` inside
  `\d .a` is `.a.f`, never the root's `f`, and a root `g` is not `.g`. A
  local or parameter of the same name is not a read, and neither is a name
  in a string or comment. A name no file defines is tried without its last
  segment, so `.cfg.opts.port` reaches the file defining `.cfg.opts`. A
  symbol handed straight to `get` or `value`, `` get`.ns.x ``, is a read
  too;
- it loads the other by a literal path, `\l path` or `system "l path"`, or
  names it as a file symbol ending in `.q`, `` `:lib/x.q ``, whatever that is
  handed to - a project's own loader is invisible to reading otherwise. q
  resolves that path against the process's directory, which the source does
  not name, so it is tried against the loading file's directory, each
  directory above it, then the current one. A script loaded under `\d .a`
  runs in `.a`, so what it defines at its root is `.a.name` as well as
  `name`, and so is what the scripts it loads at its root define.

A name several files define gives an edge to each of them - which one wins is
load order, and load order is not in the source. With `--detail` each file's
entry is `{"dependencies" (or "dependents"): [...], "ambiguous": {name:
[every file defining it]}, "dynamic": [{"line", "kind"}]}`. `dynamic` lists
each line where a name is reached by a value computed at run time, which no
amount of reading resolves: `value` of a string, `get` of anything but a
literal, a name built with `` ` sv ``, `set` into a computed name, and a
concatenated `system "l ",path`. `value` is the same function as `get` (q 5:
`get~value` is 1b), but it is listed only where the source shows its argument
is a symbol - `` value `$x ``, `value .Q.dd[...]`, or `value nm` where the
scope assigns `nm` nothing but a symbol atom - because `value` of a
dictionary, `value d`, reaches no name and reading alone cannot tell the two
apart. A parameter handed to `value` is not listed. So is `get`, `value` or `set` of an
unqualified symbol in a lambda written under `\d`: q looks the symbol up in
the `\d` current when the lambda is called, not where it is written. The
graph does not guess at those; a caller
that wants to be safe can treat such a file as depending on everything.

`--symbols` also counts a qualified symbol literal, `` `.ns.f ``, as a read
of that name, the way a callback is registered; it is off by default because
a symbol is often only data. `exclude` from a configuration file applies, and
`--exclude` adds to it. The subcommand is recognised only as the first
argument: `qlinter path.q`, `--explain` and `--lsp` are unchanged, and a
directory named `analyze` is linted as `./analyze`.

What it cannot see: a name reached through a variable holding a symbol
(`@[nm;k;:;v]` amends whatever `nm` names, and is not listed), a qSQL column
read as a global when some file happens to define a global of that name, and
a `\l` whose path only exists relative to a directory q was started in
elsewhere.

### Configuration

Settings are found the way Ruff finds its own. For each file, qlinter walks up
from the file's directory and uses the first of `.qlinter.toml`,
`qlinter.toml`, or a `pyproject.toml` with a `[tool.qlinter]` table (the older
`[tool.q-lint]` still works). A `pyproject.toml` without the table is passed
over, so a Python package's own one does not hide the repository's. Put one
file at the repository root and it governs everything beneath it, wherever
qlinter is run from; a sub-project can carry its own, and the nearest wins.
Where no directory has one, `~/.config/qlinter/qlinter.toml` (or
`$XDG_CONFIG_HOME/qlinter/`) applies, with its patterns relative to the
directory qlinter runs in, as in Ruff.

```toml
# qlinter.toml at the repository root
profile = "style"                    # general | style | styleq | uqf
exclude = ["lib/torq/", "generated"] # relative to this file; a bare name matches at any depth

[lint]
select = ["QE", "QF", "QT"]          # codes or prefixes; replaces the profile's set
extend-select = ["QS001"]            # added to whatever is selected
ignore = ["QF016"]
per-file-ignores = { "tests/*" = ["QS"] }
```

`exclude`, `extend-exclude`, `--exclude` and the keys of `per-file-ignores`
are globs read the way Ruff reads them. A pattern with a `/` anywhere in it -
`lib/`, `./lib`, `src/gen/*.q`, a trailing slash included - is anchored at the
configuration's directory (the current directory for `--exclude` and the
user-level file), so `lib/` excludes the root's `lib` and not `tests/lib`. A
pattern with no `/` at all - `lib`, `*_gen.q` - matches a file or directory of
that name at any depth. A pattern that names a directory covers everything
under it. This is gitignore's anchoring rule except for the trailing slash,
which gitignore alone treats as "directories only" rather than as an anchor;
write `**/lib` for a `lib` at any depth.

The root is the directory the pattern is written relative to, never the path
being linted: a configuration file's own directory for its patterns, and the
directory qlinter runs in for `--exclude` (and for a `--config FILE` or the
user-level file). So `qlinter .. --exclude src/`, run from `proj/tests`,
names `proj/tests/src`; a leading `../` climbs from the root, as Ruff resolves
it, and `qlinter .. --exclude ../src` is the one that names `proj/src`.

In `pyproject.toml` the same keys go under `[tool.qlinter]`, and
`[tool.qlinter.lint]`. Also: `extend-exclude`, and `extend = "../qlinter.toml"`
to inherit another file and override it - a key the extending file sets
replaces the base's, `exclude` and `per-file-ignores` included, and only
`extend-exclude` adds to it. As in Ruff, the most specific
selector wins - `ignore = ["QS"]` with `extend-select = ["QS001"]` keeps QS001
alone - and a selector that names no rule is refused, so a typo cannot quietly
select or ignore nothing.

The command line wins over the file: `--profile`, then `--select`,
`--extend-select` and `--ignore` (comma-separated or repeated) applied after
it, and `--exclude` added to it. `--config FILE` uses one file for everything,
`--isolated` ignores them all, and `--show-settings PATH` prints which file
governs a path and the rules it turns on. Exclusions apply before a file is
read or sent to qls, to the files a directory walk finds: a file named on the
command line is linted whatever `exclude` says, as in Ruff, unless
`--force-exclude` is given - which pre-commit hooks and scripts that pass every
changed file want; the rest decide which findings are reported, fixed by
`--fix` and `--diff`, and shown by the language server, which finds each open
document's settings the same way and re-reads them when one changes.

One finding on one line is accepted with a trailing comment naming its code:
`endofday:{[dt;data] dt} / noqa: QF016 TorQ's fixed signature`. Several codes
are separated by commas or spaces, and text after them is a reason. It drops
only findings reported on that line, from the output, `--fix` and the
language server alike; a bare `/ noqa` names nothing and suppresses nothing.
The built-in rules honour it; findings from qls do not.

Diagnostics carry a
code and a category; `qlinter --rules` lists them all and `qlinter --explain
QF005` describes one. Exit codes are 0 (no error or warning), 1 (findings) and
2 (input or server failure - a file that cannot be read is reported, the rest
are still linted, and the run ends in 2).

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

`textDocument/formatting` - "Format Document" - applies exactly the fixes
`qlinter --fix` applies by default, through the same loop and the same
configuration as the diagnostics: never an editor-only fix, whatever flags the
server was started with. It is not a whitespace or layout formatter, and there
is none. A document with nothing to fix, or whose brackets or strings do not
close, gets no edits; formatting twice changes nothing the second time. Range
formatting is not offered.

**The reason it is a server rather than an editor plugin shelling out to the
CLI**: `didChange` carries the buffer, so what gets linted is what is on
screen, including edits that have not been saved yet. A CLI over paths cannot
do that, and `--stdin-filename` only gets you there one editor at a time. Only
a `.q` file is linted: an untitled scratch or a console buffer labelled q gets
no diagnostics, because nothing says it holds q source rather than a REPL
transcript.

Deliberately not implemented: completion, hover, go-to-definition.
Those need a resolver and a symbol table this crate does not have — it reads
source without executing it, which is what makes it safe to run on every
keystroke. Announcing a capability and answering emptily is worse than not
announcing it, because an editor told that a server provides completion stops
offering its own word-based fallback.

### VS Code

The extension in `editors/vscode` is small: it launches the
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

Its settings - the server binary and arguments, the profile, a configuration
file, rule selection that can only narrow the repository's, when to lint,
severities, Quick Fixes, formatting, semantic colouring and the workspace
index - are listed, with which wins over which, in the [extension's
README](editors/vscode/README.md#settings). `qlinter --lsp` without
`--profile` defaults to `style`.

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

### Editor options: `initializationOptions`

What only an editor has a use for is read from the `initialize` request's
`initializationOptions`, once; a client restarts the server to change it.
Every key is optional, and these are the defaults:

```json
{"lint": {"select": [], "ignore": [], "run": "onType", "severity": {}},
 "fixes": {"unsafe": true}, "format": {"enable": true},
 "semanticTokens": {"enable": true},
 "workspaceIndex": {"enable": true, "exclude": []}}
```

`lint.select` and `lint.ignore` are rule codes or prefixes applied after the
configuration and the command line, and only turn rules off: a rule reports
when the configuration selects it and they do too. `lint.run` is `onType` or
`onSave`. `lint.severity` maps a code or prefix to `error`, `warning`,
`information` or `hint`, the longest winning. `fixes.unsafe: false` offers
only the fixes `--fix` applies; `format.enable` and `semanticTokens.enable`
set to `false` leave the capability unannounced. `workspaceIndex.exclude`
holds globs relative to each workspace folder that the index does not read.
A value the server cannot read is reported with `window/showMessage` and its
default used.

### What the server does not read

`--exclude`, and the `exclude` and `extend-exclude` of any configuration, are
not consulted in server mode. Everything else a configuration says is: the
server finds `qlinter.toml` or `pyproject.toml` above each document as the
command line does, and `--config FILE` replaces that search with the one file,
whose per-file-ignores are then read relative to the directory the server was
started in. `--isolated`, `--profile`, `--select`, `--extend-select` and
`--ignore` apply as they do on the command line. An editor asking
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
