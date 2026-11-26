# Command line

```text
qlinter [OPTIONS] [PATHS]...
qlinter analyze graph [OPTIONS] [PATHS]...
```

A directory is walked for `.q` files. `qlinter --help` has the exact text
of every option; this page groups them and says what `--help` has no room
for.

## Options

What runs:

- `--profile` `general|style|styleq|uqf` picks the rule set
  ([rules](rules.md#profiles)). `--select` replaces it with codes or
  prefixes, `--extend-select` adds to it, `--ignore` drops from it; each
  is comma-separated or repeated, and applied after the configuration.
- `--target-version` `3.6|4.0|4.1|kdbx` turns on the version check
  ([below](#the-q-version-check)).
- `--backend` `builtin|qls|all` chooses the rule engine. `qls` is KX's
  language server, installed separately and found by `--qls-executable`;
  `--qls-timeout` bounds a batch in seconds. `builtin`, the default, needs
  no other program.

Which files and which configuration:

- `--exclude` adds a glob to the configuration's `exclude`. A file named on
  the command line is linted anyway unless `--force-exclude` is given, as in
  Ruff; pre-commit hooks pass it.
- `--config` uses one file for everything; `--isolated` ignores every
  configuration file. `--show-settings` prints which file governs each path
  and the rules it turns on.
- `-` reads standard input. `--stdin-filename` gives it a path, for
  configuration and messages, and implies reading standard input.

Output:

- `--format` `text|json|sarif|github` ([below](#output)).
- `--statistics` prints a count per rule instead of the findings.
- `--output-file` writes the report to a file instead of standard output.
- `--color` `auto|always|never`; `auto` colours a terminal unless `NO_COLOR`
  is set.

Changing files:

- `--diff` prints the fixes as a unified diff; `--fix` applies them and
  reports what is left. `--unsafe-fixes` adds the fixes otherwise only
  offered in an editor ([below](#fixes)).
- `--add-noqa` appends `/ noqa: CODE` to the line of every finding.

Baselines:

- `--write-baseline` writes every finding to a file and reports none;
  `--baseline` then reports only findings not in it ([below](#baselines)).

Other:

- `--rules` lists the rules, `--explain` describes one.
- `--lsp` runs the language server on stdin and stdout
  ([lsp.md](lsp.md)). Flags that only shape a command-line run are refused
  beside it. `--stdio` is accepted and ignored, for clients that append it.
- `--version` (`-v`) and `--help` (`-h`).

The exit code is 0 when nothing at `error` or `warning` severity is
reported, 1 when something is, and 2 when an input, the configuration or
qls failed. A file that cannot be read is reported and the rest are still
linted.

## Output

A finding prints as `path:line:column`. Columns are 1-based and count
UTF-16 code units, as the LSP and VS Code do, so after an emoji the column
is one more than a count of characters.

- `json`: a list of objects; [output.md](output.md) describes each field.
- `sarif`: SARIF 2.1.0 for GitHub code scanning and other SARIF readers.
  Paths are relative to the directory qlinter runs in (`%SRCROOT%`), so run
  it from the repository root. Each result's
  `partialFingerprints."qlinterBaseline/v1"` is its baseline key, so a
  finding keeps its identity when lines are added above it.
- `github`: one workflow command (`::error`, `::warning`, `::notice`) per
  finding, which a GitHub Actions run shows as an annotation:

  ```text
  ::error file=demo.q,line=1,col=12,endColumn=14,title=QE004::q has no `==`; the spelling here is `=`
  ```

`--statistics` prints count, code and summary per rule, most frequent first;
under `--format json` it is a list of `{"code", "count", "summary"}`.

`--output-file` never writes over a file the run reads, including one reached
through a link; that is refused with exit 2.

## Fixes

`--fix` and `--diff` repeat until nothing more applies. A file that is not
valid UTF-8 is linted but never rewritten. `--diff` paths are relative to the
current directory, for `patch -p1` or `git apply`.

Batch fixing handles the rewrites that were checked in q 5 to leave a
working program alone, or to replace code that could only fail: `==`,
`!=`, `+=`, `-=`, `*=` (QE004); a leading BOM (QE005); an invalid string
escape (QE002); `true`, `false`, `None`, `return x` (QF015); a table
literal of scalars (QT005); a symbol used as a `like` pattern (QB007);
`f . ()` (QA004); a float where q wants an integer (QT008, QT014, QT017);
a number signalled (QT025); `where a:1` (QT028); the q 4 spellings q 5
refuses, `-x`, `+/x`, `cor each x` (QE008, QE009, QE011); a pasted
no-break space, dash or curly quote (QE012); redundant parentheses round
one token (QS004); and under `uqf`, the precedence parentheses and
brackets of QP005, QP006, QP007 and QP008.

Some rewrites change behaviour or guess at intent, so only `--unsafe-fixes`
or an editor Quick Fix applies them: `&&` and `||` (QE004); `reverse asc`
(QR001); `distinct asc distinct` (QR003); a symbol given to `ss` (QT007);
a lambda's trailing `;` (QB012); `a -1` (QB010); `=` on strings or a vector
in a filter (QB015, QB008); `f(a;b)` (QA008); string casts (QT004, QT032);
a statement that never runs (QB020); an unused local (QF017); `{x} each y`
and `{x+1} each a` (QR002, QR004); `abs each x` (QV002); `r:r,x` in a loop
(QV003); comparisons an `and` swallows in a where phrase (QB006); `~` in a
filter (QB005); implicit `x` beside a declared parameter (QF010);
commented-out code (QL002); an outer local a nested lambda reads (QF005);
`$[c;a;b;]` and `$[c;a]` (QA007, QA006); `10/2` (QB014); `a:a` (QB017);
a parameter that shadows a builtin (QF001); a column one typo away
(QF020); `` hopen `host:5000 `` (QT029); an unused `noqa` (QL003); and
under `uqf`, `.z.P` and datetimes (QP003, QP002).

After `--fix`, the findings left are listed, and standard error says how
many of them have only an unsafe fix.

## Baselines

```sh
qlinter --write-baseline qlinter-baseline.json src/   # once; commit the file
qlinter --baseline qlinter-baseline.json src/         # only what is new
```

`baseline = "qlinter-baseline.json"` in a configuration applies it to
every run, the language server's included. A finding is matched on its
file, its code and the trimmed text of its line, never the line number, so
lines added above it leave it matched and editing its own line makes it new.
Paths are relative to the baseline file. A missing or malformed baseline is
an error (exit 2). `--write-baseline` refuses a path ending `.q`, `.k` or
`.qnb` and any file the run lints, and writes nothing if an input could not
be read. [ci.md](ci.md#adopting-on-a-tree-with-findings) walks through
adopting one.

## The q version check

`--target-version` (or `target-version` in a configuration) reports what
does not run on that release. Without it these rules report nothing.

| rule | construct | runs on |
|---|---|---|
| QK001 | a dictionary literal, `([a:1;b:2])` | 4.1 and later |
| QK002 | a pattern assignment, `(a;b):x` | 4.1 and later |
| QK003 | a typed or filtered parameter, `{[x:`j] ...}` | 4.1 and later |
| QK005 | `.Q.Xf` or `.Q.Cf` | before 4.1 |
| QK006 | a builtin only KDB-X has, `` use`mymod `` | KDB-X |

A target before KDB-X also stops reporting what only q 5 refuses (QE008,
QE009, QE011) and lets a file use `use` as a name. The facts come from KX's
release notes; only the KDB-X side was run here.

## The dependency graph: `qlinter analyze graph`

```sh
qlinter analyze graph src/                          # {file: [files it depends on]}
qlinter analyze graph --direction dependents src/   # {file: [files that depend on it]}
qlinter analyze graph --detail src/                 # {file: {dependencies, ambiguous, dynamic}}
```

The output is JSON in the shape `ruff analyze graph` prints: every file is a
key, keys and lists are sorted, and paths are relative to the current
directory. A file depends on another when it:

- reads a global the other defines, resolved as q resolves it: a bare name
  under the `\d` in force, a name no file defines tried without its last
  segment, and a symbol handed straight to `get` or `value`;
- loads it by a literal path, `\l path`, `system "l path"` or a file symbol
  ending `.q`, tried against the current directory, then the loading file's
  directory and each one above it; a directory loads the scripts in it;
- loads it as a KDB-X module, `` use`name ``, whose names live under
  `.m.name`.

A name several files define is an edge to each, since which wins is load
order. `--detail` lists those under `ambiguous`, and under `dynamic` each
line where a name is reached by a value computed at run time (`value` of a
string, `get` of a computed name, `eval`, `` ` sv ``,
`system "l ",path`). A caller that wants to be safe can treat such a file as
depending on everything.

`--symbols` also counts a qualified symbol literal, `` `.ns.f ``, as a read,
the way a callback is registered; it is off by default because a symbol is
often only data. The configuration's `exclude` applies, `--exclude` adds to
it, and `--force-exclude` applies it to files named outright.

The graph cannot see a name reached through a variable holding a symbol,
and it may take a qSQL column for a global of the same name.
