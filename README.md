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

A finding prints as `path:line:column`. The column, and `column` and
`end_column` in the JSON, are 1-based and count UTF-16 code units, the unit
the language server protocol and VS Code use. So after a character outside
the Basic Multilingual Plane, such as an emoji in a string, the column is one
more than a count of characters (and less than a count of bytes).

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

One rule is in no profile, `uqf` included, and reports only where a selector
names it - `--extend-select QP007`, or `extend-select = ["QP007"]`; the
prefix `QP` and `ALL` name it as they name any rule. It is the
other half of QP005, which reports the precedence trap: a `*` or `%` with a
`+` or `-` to its right, as in `mid:0.5*bid+ask`, where q adds first and
school precedence would multiply first. QP007 reports the mix that is no
trap - every `+` and `-` left of every `*` and `%`, as in
`stamp:start+step*til n`, which both readings multiply first - for a tree
that wants every mix parenthesised whichever way round it is. Each message
names the operation q performs first.

QP008 is the opposite convention, for a tree that wants the bare spelling:
it reports a pair of parentheses that only restates q's order, exactly where
the QP005 and QP007 fix would have written it, and its fix removes the pair -
`mid:0.5*(bid+ask)` becomes `mid:0.5*bid+ask`. A pair that changes the
grouping (`(0.5*bid)+ask`), holds the same family (`a+(b+c)`), is a list or
an argument, or whose removal would fuse two tokens (`a -(1+b)`) is never
reported. The two fixes are inverses: with F the forward fix and R the
reverse, R(F(x)) is R(x) and F(R(x)) is F(x), byte for byte. Only its own
code selects QP008 - a prefix or `ALL` would turn both conventions on - and
a run where it and QP005 or QP007 would both report on a file is refused
with a message naming the two, since `--fix` would undo itself; under `uqf`,
select it with `--ignore QP005`. The language server keeps the forward rule
there and says so on standard error.

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
a file, or anywhere `NO_COLOR` is set to a nonempty value. `--color always|never` overrides the
guess in either direction. JSON output never carries colour.

`qlinter --version` (or `-v`) reports the build, and `--stdio` is accepted and ignored
so a client that appends it gets a server rather than an exit code.

The CLI supports `--profile general|style|styleq|uqf`, `--format text|json`,
`--exclude`, `--config`, stdin (`-`, `--stdin-filename`; the name alone reads
stdin too, as in Ruff, either refuses other paths beside it, and a name that is
not a `.q` file is refused as that file named outright is) and
`--backend builtin|qls|all` options. The default is builtin.
`--qls-executable` chooses the separately installed server;
`--qls-timeout` bounds a batch, plus at most one second for cleanup.
The qls server may itself require Python; the Rust builtin backend does not.

To preview mechanical edits, run `qlinter --diff path/to/file.q` - a unified
diff with paths relative to the current directory, which `patch -p1` takes as
it is, and `git apply` too for files under the current directory: a file
outside it is named through `..`, and git applies no patch to a path outside
the directory it runs in, so run it from one that holds the files. To write
the edits, run `qlinter --fix path/to/file.q`.
`--fix` re-lints the changed files and reports any remaining findings, and
says on standard error how many of them it has no fix for, so that a finding
still listed is not taken for one to run `--fix` on again. Batch fixing handles `==`, `!=`, `+=`, `-=`,
`*=`, a leading UTF-8 BOM, an invalid string escape (`"C:\data"` →
`"C:\\data"`), `true`/`false`/`None`/`return x` → `1b`/`0b`/`(::)`/`:x`,
a table literal of scalars (each column enlisted), a symbol used as a `like`
pattern (`` `a* `` → `"a*"`), `f . ()` → `f[]`, `til 5.0` → `til 5` (and `2.0 rotate`, `3.0 mavg`),
a number signalled → a string, `where a:1` → `where a=1`, `distinct asc distinct` → `asc distinct`,
redundant parentheses around one token (styleq), and - under `--profile uqf` -
parentheses showing the order q already evaluates `a*b+c` in (QP005, and
QP007 for `a+b*c` where that is selected) or removing them where QP008 is
selected, and the
brackets QP006 asks for, rewriting `f x` as `f[x]` with whatever the
application swallowed. Each was checked in q 5 to leave the program alone, or
to replace code that could only fail.

Some rewrites change behaviour or guess at intent, so they remain editor Quick
Fixes that you choose individually: `&&` → `&`, `||` → `|`, `reverse asc` →
`desc` (they differ on a dictionary's tied keys), a symbol given to
`ss`/`ssr` → a string, dropping a lambda's trailing `;` so it returns its last
value, `a -1` → `a - 1`, a string compared with `=` in a filter → `like`
(on a char column as long as the string, `=` is valid q), `=` against a
vector in a filter → `in`, `f(a;b)` →
`f[a;b]`, `` `int$"12" `` → `"I"$"12"`, `` `symbol$"abc" `` → `` `$"abc" ``, removing a statement that never runs,
removing an unused local's name while keeping its expression,
`{x} each y` → `y` and `{x+1} each a` → `a+1` (they differ on an empty typed list, and
`{x} each` drops a `` `s# `` or `` `g# `` attribute), parentheses
round each comparison an `and`/`or` swallows in a where phrase, `~` → `=` in
a filter, `x` → the one declared parameter, deleting a commented-out
definition, passing an outer local into a nested lambda that reads it
(`{a+x}` → `{[x;a] a+x}[;a]`), dropping the trailing `;` of `$[c;a;b;]`,
`$[c;a]` → `if[c;a]` where nothing takes its value, `10/2` → `10%2`, removing `a:a`, renaming a parameter
that shadows a builtin, a column one typo from the table's, and (uqf)
`.z.P` → `.z.p` and datetime → timestamp. Add
`--unsafe-fixes` - Ruff's flag of the same name - to have `--diff` and `--fix`
include them. Both CLI options use the builtin backend (or `--backend all`);
`--fix` requires file paths rather than stdin.

`--fix` and `--diff` repeat until nothing more applies, so where one
juxtaposed call is the argument of another, both are bracketed in one run.
Inside a qSQL phrase a call is bracketed up to the comma, `by`, `from` or
`where` that ends its column or constraint - q 5 reads `select v:g s by k from
t` as `g[s]`. A call in the table expression after `from` is left alone, as is
one whose argument holds a query of its own: after `from`, q reads up to
`where` as one expression (`select from g v,w` is `g[v,w]`), and this tool
does not parse. Each keeps its finding, so nothing is silently dropped.

QP005 and QP007 share one fix: parentheses round the right operand of the
operator before the change of family, which is where q groups already -
`2*3+4` and `2*(3+4)` are one parse tree. It reaches a mix on any line of a
statement - a lambda's body, a bracketed argument, an item of a list or a
column of a table literal - where the operand ends at the `;` or the bracket
that closes round it. In a qSQL phrase the operand ends where the phrase
does: at the comma, `by` or `from` of a column or grouping list, at the comma
of a `where` constraint, and after `from` at `where` or the template's end,
since the table is one expression and a comma in it is a join - as is a comma
inside parentheses anywhere. A dotted name is a name whatever it ends in:
`x:.a.from+0D01*1+til 5` becomes `x:.a.from+(0D01*(1+til 5))`. A nested mix
takes a pair for each change, in one run: under QP005 alone
`d:s*1+0.0005*-1+2*r` becomes `d:s*(1+(0.0005*(-1+2*r)))`, and with QP007
selected too the last `2*r` is parenthesised as well. The fix is refused,
and the finding kept, where the operand's end cannot be told: a right side
that ends in an operator or `::` and so is a composition, an operator applied
in brackets (`a*[b;c]+d`), and a template that opens inside the phrase of
another without parentheses of its own, whose table then takes the commas
after it.

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
  symbol handed straight to `get` or `value`, `` get`.ns.x `` or
  `` get[`.ns.x] ``, is a read too;
- it loads the other by a literal path, `\l path` or `system "l path"`, or
  names it as a file symbol ending in `.q`, `` `:lib/x.q ``, whatever that is
  handed to - a project's own loader is invisible to reading otherwise. q
  resolves that path against the process's directory and nowhere else, which
  the source does not name, so it is tried against the current directory,
  then the loading file's directory and each directory above it. A
  directory loaded, `\l db`, leads to each script directly in it, which q
  runs - tried against the current directory only. A script loaded under `\d .a`
  runs in `.a`, so what it defines at its root is `.a.name` as well as
  `name`, and so is what the scripts it loads at its root define; a name it
  reads there is looked up in `.a` as well.

A name several files define gives an edge to each of them - which one wins is
load order, and load order is not in the source. With `--detail` each file's
entry is `{"dependencies" (or "dependents"): [...], "ambiguous": {name:
[every file defining it]}, "dynamic": [{"line", "kind"}]}`. `dynamic` lists
each line where a name is reached by a value computed at run time, which no
amount of reading resolves: `value` of a string, `get` of anything but a
literal, `eval` or `reval` of a parse tree, a name built with `` ` sv ``,
`set` into a computed name, and a
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
`--exclude` adds to it; a file named outright is left out by them only with
`--force-exclude`, as when linting. The subcommand is recognised only as the first
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

Until a configuration sets `exclude`, a walk skips directories named `.git`,
`.venv`, `node_modules`, `__pycache__`, `build`, `dist` and `target` at any
depth. As in Ruff, that list is `exclude`'s default: a configuration's own
`exclude` replaces it (`exclude = []` walks them all), and `extend-exclude`
adds to it.

The root is the directory the pattern is written relative to, never the path
being linted: a configuration file's own directory for its patterns, and the
directory qlinter runs in for `--exclude` (and for a `--config FILE` or the
user-level file). So `qlinter .. --exclude src/`, run from `proj/tests`,
names `proj/tests/src`; a leading `../` climbs from the root, as Ruff resolves
it, and `qlinter .. --exclude ../src` is the one that names `proj/src`.

Under `uqf`, QP002, QP003 and QP005 - and QP007 where it is selected - pass
over a file in a `tests`
directory below that root - the configuration's directory, or the current
one without a configuration - since a test may build a datetime or read the
local clock on purpose. A `tests` above the root exempts nothing, and
`--select` naming one of them reports it regardless.

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
A comment line at the left margin, `/ qlinter: noqa: QS001, QF016 reason`,
accepts those codes on every line of its file, as Ruff's `# ruff: noqa:` does;
inside a block comment or after the line that ends the script it is not read.
The built-in rules honour both; findings from qls do not.

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
`!=` → `<>`, `+=`/`-=`/`*=` → `+:`/`-:`/`*:`, and a leading UTF-8 BOM -
the BOM only where the editor sends one: VS Code decodes a UTF-8 file's BOM
away before the server sees the text and writes it back on save, so there
QE005 is never shown and Format Document leaves the BOM, which
`qlinter --fix` removes.
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

Around those:

- Each diagnostic links its code to that rule's row in
  [docs/rules.md](docs/rules.md) (`codeDescription`), so the code is clickable
  wherever an editor shows it.
- Every finding has a Quick Fix, "Suppress CODE on this line", that writes
  `/ noqa: CODE` after its line, or adds the code to the `noqa` already there.
  It is offered only where the linter would read that comment and q would
  still run the same line: not on a line that ends inside a string, a system
  command, a `k)` or `p)` line, a block comment or the bare `/` that opens
  one, nor in a file whose brackets or strings do not close. It is never the
  preferred fix. Beside it, "Suppress CODE in this file" adds the code to the
  file's `/ qlinter: noqa:` line, or writes one at the top of the file (after
  a `#!` line). `suppressions.enable: false` withdraws both.
- `textDocument/codeAction` answers the kind `source.fixAll.q-lint` - asked
  for by that name, or as `source.fixAll` or `source` - with the edit Format
  Document makes. That is how an editor applies the safe fixes on save where
  q-lint is not its formatter; a request that names no kind gets the Quick
  Fixes alone.
- `textDocument/foldingRange` folds the lambdas, parenthesised lists,
  bracketed blocks and block comments that span lines, found in the masked
  text so that a bracket in a string or a comment folds nothing. A statement
  continued over indented lines with no bracket open is not a range.
- While a bracket or a string is open - every keystroke of a call or a
  string being typed - a file reports only QE001, as the CLI does, placed at
  the bracket that is not closed rather than the closer it runs into. The
  rest of the file is not blanked meanwhile: the diagnostics and folds of the
  last version whose brackets all closed are kept on every line that has not
  changed since, moved up or down by the lines added or removed above them,
  except within the statement that does not close. They are the last good
  results, so a finding that an unchanged line owes to the statement being
  typed goes only once that statement closes. A file that has not closed
  since it was opened has only the QE001, and no folds.

The server answers one message at a time, in the order they arrive, and
reads ahead while it works. A change to a document that has another change
to the same document queued behind it is taken but not linted, so a burst of
keystrokes on a large file is linted once, at the last of them: twenty
one-character edits to a 1,948-line file publish diagnostics twice and the
final ones arrive about 0.1 s after the first edit, where each edit used to
be linted in turn and the last diagnostics took about a second. A request
still queued when its `$/cancelRequest` arrives is answered
`RequestCancelled` (-32800) and is not run. A request already running is not
interrupted. A request whose document changes behind it is still answered
on the text it was asked about, since LSP 3.17 tells a server not to answer
`ContentModified` for a change it has not yet handled.

**The reason it is a server rather than an editor plugin shelling out to the
CLI**: `didChange` carries the buffer, so what gets linted is what is on
screen, including edits that have not been saved yet. A CLI over paths cannot
do that, and `--stdin-filename` only gets you there one editor at a time. Only
a `.q` file is linted: an untitled scratch or a console buffer labelled q gets
no diagnostics, because nothing says it holds q source rather than a REPL
transcript.

**Navigation** is read from the same source the diagnostics are, without
running it: `textDocument/documentSymbol` (the outline; nested or flat, as
the client declares), `workspace/symbol`, `textDocument/definition`,
`textDocument/references`, `textDocument/documentHighlight` (a write told
from a read), and `textDocument/prepareRename`/`textDocument/rename`.

The nested outline puts each name under the namespace it is in, the whole of
the name before its last dot: `.qetl.io.read` is `read` under `.qetl.io`,
written with the dot or under `\d .qetl.io`. It is one level deep, a group per
context the file writes into, rather than one level per dot, which would put a
file that writes only into `.qetl.io` under a `.qetl` with a single child. A
namespace the file also assigns whole (`.cfg:()!()` beside `.cfg.port:5010`)
is that assignment, holding the names in it. A client that does not declare
`hierarchicalDocumentSymbolSupport` gets the flat list.

Go to Definition on a name several files assign lists the current file's own
assignment first, then those in files it loads (directly or through another
file), then those in files that load it, then the rest. When the current file
assigns the name itself, the rest are left out: a script that neither loads
nor is loaded by this one, by any chain of `\l`, is a separate program that
happens to use the same name, and eight scripts that each start with
`opts:.Q.opt .z.x` should not all be offered from one of them. A file
connected by a load stays, because it may run in the same process and which
assignment ran last is not something reading can tell.

`workspace/symbol` ranks before it cuts to 512: the name itself, then a name
whose last segment is the query (`.u.st` for `st`), then names starting with
it, then names containing it, then names holding its letters in order. A query
of several words (`bounded fail`) matches names containing every word. Case is
ignored.

On the path of a load - `\l src/init.q`, `system "l src/init.q"`, or a file
symbol `` `:lib/x.q `` - Go to Definition opens the file and a hover names it.
The path is followed as the dependency graph follows it: against the first
workspace folder, then the loading file's own directory and each one above it;
a directory loads the scripts directly in it. A load that reaches no file, or
a relative one written after the script changes directory, goes nowhere.
`textDocument/documentLink` makes each such path a link to the file it
reaches, found the same way, with the file under its workspace folder as the
tooltip; a load that reaches no file, or a directory (several files), has
none. `documentLinks.enable: false` leaves it unannounced.

A global is named as q would resolve it where it is written: under the `\d`
context in force, in each context a file is loaded in when it names none of
its own, in `.q` when nothing else defines the bare name, and at the
assignment of the nearest namespace when `.cfg.n` exists only because `.cfg`
was assigned whole. Every way of writing one that the linter already reads
counts as a definition - `name:`, `name::` in a lambda, `` `name set ``,
an amend of `` `. `` - and an open buffer is read as the editor has it. A
definition inside a lambda is still that global's definition. What only
running the code would tell is not found: a name built at run time, a
`value "..."` string, a definition another process sends. A column in a qSQL
phrase reads like a global of that name and is listed with it.

Rename takes a lambda's parameter or local, within its lambda, and a global
across the workspace. A local is refused, with the reason in the error, when
it is an implicit `x`, `y` or `z`, when a qSQL phrase reads it (it may be a
column), and when the new name is a q builtin or one the lambda already uses.

A global is renamed in every place Find All References lists - each indexed
file that names it, under the `\d` in force and the context the file is
loaded in - and only its last part changes: `.lib.add` and `add` under
`\d .lib` both become `plus`, given as `plus` or as `.lib.plus`, and a name
in another namespace is refused. `prepareRename` answers with the range of
that last part. `rename.enable: false` leaves renaming unannounced, and the
rest of navigation on. The rename is refused for a name in a one-letter namespace
(`.z.pg`, `.q.f`, which q keeps for itself), a name no indexed file assigns
(q's own, or defined where the server cannot read), a new name that is not
one q takes, is reserved or is already assigned, and one that is a
parameter or local of a lambda reading the global without its namespace,
where it would hide the renamed global. What reading cannot find keeps the
old name: a string handed to `value`, a bare symbol (`` `f ``), a name another
process sends.

Hover, signature help and completion answer from two places and never from a
running q: the workspace's own source, and a catalogue of q's words that ships
in the binary (`src/builtins.json` - the keywords, the control words, the
commonly used names under `.z`, `.Q`, `.h` and `.j`, and the operator and
iterator glyphs).

A hover on a name the workspace defines shows `name[a;b]` for a function - the
signature it declares, or `x`, `y` and `z` as far as its body reads them, or
the slots a projection leaves open - and the line that assigns anything else,
then the comment directly above the definition (`/` lines, or a block comment
ending there) and the file. A name several files define shows each, up to
five, ranked and narrowed as Go to Definition is; signature help lists them in
the same order. A word of q shows how it is written, a line on what it gives, and a link
to its page on code.kx.com, and so does a glyph - `+`, `#`, `/:` - outside a
name, a number, a string and a comment. A lambda's own parameter or local
shows the type its assignments settle, when they settle one (below), and
nothing otherwise: its definition is on screen.

Signature help answers inside the brackets of a call written as a name -
`.lib.add[1;`, or `.lib.add [1;`, which q reads the same - with the
parameters and the one being written, inside a string still open there too.
A name assigned another name (`al:add`) or a projection of one
(`pr:add[;2;]`) is called as what it leads to: the alias with all of `add`'s
parameters, the projection with the slots it leaves open. A lambda called in
place, an operator's bracket form (`$[`, `@[`, `.[`, `?[`, `![`) and a call by
juxtaposition have no signature shown. `if`, `do` and `while` take any number
of expressions, so the last parameter stays marked; past the last parameter
of anything else no parameter is marked, and the signature says the call has
too many arguments.

`textDocument/inlayHint` draws a parameter's name before each argument of a
bracketed call to a workspace function in the range asked about: `f[a:1;b:2]`
over `f[1;2]`, the call written qualified or bare under the `\d` in force. A
hint is given only when every definition of the name assigns a lambda with a
signature, and the same one: an implicit `x`, `y` or `z` names nothing a
reader does not know, and definitions that disagree leave which one is called
to whichever ran last. An empty slot of a projection, an argument past the
last parameter and one spelled as the parameter itself get none.
`inlayHints.enable: false` turns them off.

A local's type is inferred only where reading settles it: every assignment of
the local in its lambda is a plain `a:` of a literal - a number or a vector
of them, a boolean, a byte, a string, a symbol or several, a date or a time,
a lambda, or `()` - and all of them give the same type. Then an inlay hint
after the value of its first assignment names the type (`a:1 2 3 long
list`), and a hover on the local says it and the number `type` gives
(`7h`). Anything else shows nothing: an expression, even `1+2`; a
parameter; an amend (`a+:1`, `a[i]:2`); `(a;b):`; two literals of different
types; a literal q refuses (`2024.02.30`); a name in a qSQL phrase, which may
be a column. Each type is the one KDB-X's `type` gives for the same text,
and `tests/assist.rs` checks the table against a running q.
`inferredTypes.enable: false` turns both off.

`textDocument/codeLens`, when `codeLens.enable` asks for it, puts a **Run**
lens on the name of each function a statement at column 0 defines, and a
**Run test** lens too when its name starts `test_`, or `test` and a capital
as qUnit's do. Each runs the command
`q-lint.runDefinition` with two arguments: the code to send and the
document's URI. Run's code is the statement, wrapped in `\d .ns` and `\d .`
when it is written under `\d .ns`; Run test's is that, then a call of the
function by its full name with no argument (`.ns.test_x[]`). It is off by
default because only a client that registers that command - the VS Code
extension, which sends the code to the connected q process - can run it.

With `referenceLens.enable`, the same functions get a lens counting the
places the indexed files read them - what Find All References lists without
the assignments: `1 reference`, `3 references`, `0 references`. It runs the
command `q-lint.showReferences` with the document's URI and the name's
position, which the VS Code extension opens as the references list. It is
off by default for the same reason as Run. One request reads each workspace
file that spells one of the document's function names, once.

A code action of kind `refactor.rewrite`, **Generate qDoc for f**, is offered
inside a function a statement at column 0 defines, with no `context.only` or
one naming `refactor`: it inserts `/ @param p` for each parameter a caller
passes and `/ @return` at the start of the definition's line, below any
description already there, and is not offered when the comment above has an
`@param` or `@return`. `generateQdoc.enable: false` withdraws it and its kind
from `codeActionKinds`.

A code action of kind `refactor.extract.function`, **Extract function as
extracted**, is offered over a selection - with no `context.only` and no
diagnostics in the request, or with a `context.only` naming `refactor` or
`refactor.extract`. It defines the selection as a lambda directly above the
top-level statement it is in, so under the same `\d`, taking as parameters
the parameters and locals of the lambda around it that the selection reads,
and puts a call to it in the selection's place:
`f:{[a;b] a+b*2}` with `b*2` selected becomes `extracted:{[b] b*2}` and
`f:{[a;b] a+extracted[b]}`. The name is `extracted`, or `extracted2` and on,
whichever the file does not already spell. Only a selection q reads as one
value is rewritten: a single term (a name, a literal, a bracketed group,
with its indexes) anywhere, or everything from a noun to the end of its
expression - q reads right to left, so `y*z` in `x+y*z` is one, and `x+y`
is not. A selection that assigns or returns, names `.z.s`, sits in a qSQL
phrase or a signature, cuts a name, string, symbol or list of numbers, or
reads more than 8 locals is refused; to a client with
`codeAction.disabledSupport` that asked by kind, the action comes back
disabled with the reason. `extractFunction.enable: false` withdraws it and
its kind.

A code action of kind `source.organizeImports.q-lint`, **Organise loads**, is
returned only to a request that asks for it by kind - `source.organizeImports`,
which VS Code's Organize Imports and `editor.codeActionsOnSave` send. In each
run of consecutive `\l` lines it loads a path once, at its first place, and
sorts the rest: absolute paths (`/`, `~`, `$`, a drive) first, then relative
ones, each by path without regard to case, with a blank line between the two
groups. Load order is meaning in q - a file can read what an earlier one
defined - so it is never a fix and `--fix` never makes it, and it leaves alone
a run with a load that is not a `.q` or `.k` file (`\l db` loads a database
and changes directory, which the relative loads after it depend on), runs a
blank line or anything else separates, loads in a block comment or after the
end of the script, and a file whose brackets do not close.

`q-lint/formatChangedLines`, a request of this server's own, takes a
document and `lines`, pairs of 0-based first and last lines, and answers the
edits Format Document would make for the findings on those lines only - the
lines moving with the edits as they are made. It is how an editor formats
only what changed on save: which lines changed is git's to say and the
client's to ask, so the server is given them. It answers `[]` unless
`formatChangedLines.enable` is `true`.

A code action of kind `refactor.rewrite`, **Lay out qSQL query on aligned
lines**, is offered inside a `select`, `exec`, `update` or `delete` - with no
`context.only` and no diagnostics in the request, or with a `context.only`
naming `refactor`. It puts each clause on its own line, `by`, `from` and the
`where` after `from` right-aligned under the first word, and a clause's
columns or constraints one per line when they do not fit in
`qsqlLayout.lineLength`. It replaces only blanks - before those words, and
after a comma that separates two items - and is not offered in a query where
a newline there could change what q reads: one with a comment in it, one
broken over lines somewhere else, one with another query word at its own
depth, or one on a `\t` line. With `qsqlLayout.onFormat`, formatting lays
out every query longer than `qsqlLayout.lineLength` after the safe fixes;
the fix-all action never does. `qsqlLayout.enable: false` withdraws both.

Completion is off unless `completion.enable` asks for it, because an editor
told that a server completes stops offering the words already in the buffer,
and this server's list is narrower than that fallback in one way that matters:
it knows no table's columns, no key of a dictionary and nothing a running
process defines. What it offers, in this order: the parameters and locals of
the lambda being written; the names the workspace defines, spelled as the
`\d` context in force reads them; q's words; and every name by its full
path. Nothing is offered in a string, a comment, a symbol, a number or a
system command.

With `autoLoad.enable` too, a workspace name that one other file defines,
and that nothing the document can already see defines, comes with the `\l`
that loads that file as an `additionalTextEdits` entry, so the line is
written only when the item is accepted; its `detail` says `adds \l
lib/util.q`. "Can already see" is the document itself, every file it loads
directly or through another, and every file loaded by a file that loads it -
a sibling its loader brings in - so a load already there is never added
twice. The path is written from the first workspace folder, or else from the
document's own directory, whichever the dependency graph follows to that
file. The line goes after the last `\l` line above the cursor and above the
file's first `\d`, keeping the loads' order; with none, after a leading
`#!` line and comment block. A name two files define gets no edit: which to
load is the reader's call.

**How files and functions relate** is read the same way, and comes in three
requests.

`textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls` and
`callHierarchy/outgoingCalls` are the references list, grouped. A hierarchy
starts on a global function, wherever it is named, and has one item for each
file that assigns the name a lambda. Its incoming calls are the top-level
definitions whose statement names it, each with every place it does; a
place outside every definition - a script's own `main[]` - is put under an
item for the file itself (`SymbolKind` File, detail `top level`), which has
calls and no callers. Its outgoing calls are the workspace functions its own
statement names. This is what the source spells, which is more than calls and
less than all of them: a function handed on as a value (`f each x`,
`` `handler set f ``) is listed as called, and one reached through a string,
a symbol built at run time or another process is in no list. Only a name
assigned a lambda starts a hierarchy, so a projection or an alias (`g:f`)
is a caller and never a callee, and what a function assigned inside another
names is listed under the definition around it.

`q-lint/graph` and `q-lint/affectedTests` are this server's own, announced
under `capabilities.experimental` by those names, and answer from the graph
[`qlinter analyze graph`](#the-dependency-graph-qlinter-analyze-graph)
prints - the same edges by the same rules, over the indexed files with open
buffers as the editor has them, and without `--symbols`:

```
q-lint/graph          {"textDocument": {"uri": U}}
                   -> {"uri": U, "dependencies": [uri], "dependents": [uri],
                       "ambiguous": {name: [uri]}, "dynamic": [{"line": 1-based, "kind": K}]}
                      or null for a document that is not an indexed .q file
q-lint/affectedTests  {"changed": [uri]}
                   -> {"tests": [{"uri": uri, "reaches": [index into "changed" below],
                                  "self": its own index there, or null}],
                       "changed": [uri], "unindexed": [uri]}
```

`affectedTests` lists the test files that reach a changed file along the
graph, a changed test among them. Which files changed is the client's to
say: the server starts no process and so never asks git - the VS Code
extension sends what differs from `HEAD` and what is untracked. `changed`
in the answer is the sent files the index holds, each once; `unindexed` is
the sent `.q` files it does not hold - deleted, excluded, outside the
workspace - whose dependents cannot be followed, so a client can say the
list is short. A test file is a `.q` file named `test_*` or `*_test`, or
under a directory named `test` or `tests` below its workspace folder, which
is wide on purpose: a helper listed with the tests costs a glance, a test
left out costs a regression. The limits are the graph's: an edge through a
name built at run time is not there (`dynamic` says where a file has one),
and a name several files define is an edge to each. It lists; running the
tests is left to whatever runs them. Each request draws the graph again
from what the index already holds - about a quarter of a second over 3,665
files - so a client should ask when a view is shown or a file saved, not on
every keystroke.

Five more of its own, also under `capabilities.experimental`, are what a
client asks before it talks to a q process, or as the cursor moves. The server runs nothing and
connects to nothing: it reads, and the client runs the tests, reads the
value or asks the process which names it defines.

```
q-lint/tests            {} or {"textDocument": {"uri": U}}
                     -> [{"uri": uri, "tests": [{"name": as written, "range": R,
                                                  "code": C, "call": "ns.test_x[]"}]}]
q-lint/globalAt         {"textDocument": {"uri": U}, "position": P}
                     -> {"names": [name q may resolve it to], "range": R}, or null
q-lint/unresolvedNames  {"textDocument": {"uri": U}}
                     -> [{"names": [name], "written": as written, "range": R}]
q-lint/argumentSlot     {"textDocument": {"uri": U}, "position": P}
                     -> {"range": R, "index": n, "callee": as written,
                         "parameter": name or null, "hinted": bool}, or null
q-lint/defined          {"names": [name]}
                     -> [bool]
```

`tests` lists the functions a **Run test** lens is drawn over, in every
indexed file or one: `code` is the lens's (the statement, wrapped in `\d`
when written under one) and `call` runs it. `globalAt` names the global at
a position, and is null on a local, a word of q's or nothing. `unresolvedNames`
lists the globals a document reads that no indexed file defines - not q's
words, a one-letter namespace's names, a system command's, or one in a qSQL
phrase other than the table after `from`, which may be a column.
`argumentSlot` is the argument of a bracketed call the cursor is in: its
range as written (empty for an empty slot), its index, and the parameter it
is passed as, from the definition or q's catalogue; `hinted` says whether a
parameter inlay hint already writes that name before it. `defined` says,
for each name, whether an indexed file defines it.

Every answer names a file the way the client knows it: an open document by
the URI it was opened with, and a file under a workspace folder by that
folder's URI as the client sent it, followed by the path below it. A
workspace opened as `/tmp/ws` on macOS, where `/tmp` links to
`/private/tmp`, is answered as `/tmp/ws/lib.q`, so the editor does not open
a second copy of a file it already has open. The server still keys each file
by its real path, so the two spellings are one file to it. Only a file
outside every folder is named by its real path.

### VS Code

The extension in `editors/vscode` is small: it launches the
server and lets the protocol do the rest.

Two things in it are its own, because the protocol has no word for them: a
**q Dependencies** view of the active file's `q-lint/graph`, and **q-lint:
List Affected Tests**, which asks git for the files changed against `HEAD`
(`git diff --name-only HEAD` and the untracked files, run without a shell
and only in a trusted workspace), adds the q buffers not yet saved, and
lists what `q-lint/affectedTests` answers. Choosing a row opens the file;
nothing is run.

```sh
cargo build --release                      # produces target/release/qlinter
cd editors/vscode && npm install && npm run compile
```

Then either press <kbd>F5</kbd> in that directory to open an Extension
Development Host, or package and install it:

```sh
mkdir -p server && install -m 755 ../../target/release/qlinter server/qlinter
npx vsce package --out q-lint.vsix         # a name no release bump makes stale
code --install-extension q-lint.vsix
```

`server/` is not committed: a package carries the binary built from the
tree it is packaged from, never an older one under the same version.
`python3 scripts/dist.py build` does all of this for this machine.

Its settings - the server binary and arguments, the profile, a configuration
file, rule selection that can only narrow the repository's, when to lint,
severities, Quick Fixes, formatting, semantic colouring and the workspace
index - are listed, with which wins over which, in the [extension's
README](editors/vscode/README.md#settings). `qlinter --lsp` without
`--profile` defaults to `style`.

The extension also contributes what needs no server: the grammar, and
snippets for the forms q is mostly written in (`editors/vscode/snippets/q.json`).

It also connects to q processes, which the server never does: a
**Processes** view, queries of the current line, selection or block, their
output and a query history. These live in the extension alone, and touch a
process only once the user adds it, connects and runs code - see the
[extension's README](editors/vscode/README.md#q-processes-and-queries).

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
 "semanticTokens": {"enable": true}, "navigation": {"enable": true},
 "help": {"enable": true}, "completion": {"enable": false},
 "callHierarchy": {"enable": true}, "graph": {"enable": true},
 "rename": {"enable": true}, "inlayHints": {"enable": true}, "codeLens": {"enable": false},
 "documentLinks": {"enable": true}, "generateQdoc": {"enable": true},
 "extractFunction": {"enable": true}, "autoLoad": {"enable": false},
 "referenceLens": {"enable": false}, "inferredTypes": {"enable": true},
 "suppressions": {"enable": true},
 "organiseLoads": {"enable": true}, "performanceLints": {"enable": true},
 "formatChangedLines": {"enable": false},
 "qsqlLayout": {"enable": true, "onFormat": false, "lineLength": 80},
 "workspaceIndex": {"enable": true, "exclude": []}}
```

`lint.select` and `lint.ignore` are rule codes or prefixes applied after the
configuration and the command line, and only turn rules off: a rule reports
when the configuration selects it and they do too. `lint.run` is `onType` or
`onSave`. `lint.severity` maps a code or prefix to `error`, `warning`,
`information` or `hint`, the longest winning. `fixes.unsafe: false` offers
only the fixes `--fix` applies; `format.enable`, `semanticTokens.enable`,
`navigation.enable` and `help.enable` (hover and signature help) set to
`false` leave the capability unannounced - the last two for when another q
language server already answers those requests. `completion.enable` is the
one that starts off; `true` announces completion.
`callHierarchy.enable` set to `false` leaves the call hierarchy unannounced,
and `graph.enable` does that for `q-lint/graph` and `q-lint/affectedTests`,
which then answer `null`; `inlayHints.enable` and `inferredTypes.enable` do
it for inlay hints when both are `false`, and `codeLens.enable: true` or
`referenceLens.enable: true` announces code lenses. `autoLoad.enable: true`
adds loads to completions, when completion is on.
`suppressions.enable: false` withdraws both "Suppress CODE" Quick Fixes,
`organiseLoads.enable: false` Organise loads and its kind, and
`performanceLints.enable: false` ignores the QV rules as `lint.ignore`
would. `formatChangedLines.enable: true` answers `q-lint/formatChangedLines`.
`workspaceIndex.exclude`
holds globs relative to each workspace folder that the index does not read.
The index stops after 20,000 `.q` files or 500,000 directory entries of any
kind, whichever comes first, so a folder opened at `/` cannot stall the
server; past that, a name defined only in a file it did not reach is
reported as undefined in the editor where `qlinter .` would not.
A value the server cannot read is reported with `window/showMessage` and its
default used.

### What the server does not read

`--exclude`, and the `exclude` and `extend-exclude` of any configuration, do
not hide diagnostics on a document the editor opens. They do decide which
closed files the workspace index reads, as they decide which files
`qlinter .` visits, so a name only an excluded file defines is undefined in
the editor as it is in the terminal. Everything else a configuration says is
read too: the server finds `qlinter.toml` or `pyproject.toml` above each
document as the command line does, and `--config FILE` replaces that search with the one file,
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

The taxonomy contains 126 codes. Ten literal-call rules cover excess builtin
arguments (QA010), invalid literal types/shapes (QT008–QT014), and negative
`til`/`where` counts (QD001–QD002). These checks leave unknown expressions
unresolved and account for projections, seeded scans and variadic `enlist`.

`examples/showcase.q` marks each expected diagnostic with `expect-next`.
`tests/showcase.rs` checks exact code/line pairs under every profile, including
silence in the clean section. Together with the three companion examples -
`syntax-error.q`, `byte-order-mark.q` and `query-injection.q`, each holding
a rule that would hide or stop the others - it covers all 124 rules available
in this build; QF006 and QLS001 are excluded.

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
