# Getting started

A first run, start to finish. [install.md](install.md) gets the binary;
[cli.md](cli.md) covers every option.

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

The rules are heuristics over source text. A clean run means no rule
matched, which is weaker than "this code is correct".

## Choosing rules

A profile picks the rule set (the full table, and the *no profile* rules, are
in [rules.md](rules.md#profiles)). With no profile set, the command line
uses `uqf` and the language server uses `style`. Narrow the set in the
repository's configuration ([configuration.md](configuration.md)). A few
conventions are in no profile (QP007, QP008) and run only when selected by
their code.

## Accepting a finding

A finding can be accepted on its line with a comment, or for a whole file
with a directive at the left margin:

```q
endofday:{[dt;data] dt} / noqa: QF016 TorQ's fixed signature
/ qlinter: noqa: QS001
```

`qlinter --add-noqa src/` writes that comment for every current finding.
A `noqa` that suppresses nothing is itself reported (QL003). Details:
[configuration.md](configuration.md#suppressing-a-finding).

## The main options

`qlinter --help` lists every option. The main ones:

| to | use |
|---|---|
| change the output format | `--format json`, `sarif` or `github` ([output.md](output.md)) |
| count findings per rule | `--statistics` |
| write the report to a file | `--output-file PATH` |
| choose rules | `--profile`, `--select`, `--extend-select`, `--ignore` |
| report only new findings | `--write-baseline FILE` once, then `--baseline FILE` |
| check against an older q | `--target-version 3.6`, `4.0`, `4.1` or `kdbx` |
| see which configuration and rules apply | `--show-settings PATH` (JSON with `--format json`) |
| add KX's qls as a second backend | `--backend qls` or `--backend all` |

## A configuration file

For each file, qlinter walks up from its directory and uses the first
`.qlinter.toml`, `qlinter.toml`, or `pyproject.toml` with a `[tool.qlinter]`
table. One file at the repository root governs everything below it.

```toml
# qlinter.toml
profile = "style"
exclude = ["lib/vendor/", "generated"]
target-version = "4.1"
required-version = ">=0.41"

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
[configuration.md](configuration.md) lists every key;
[`editors/vscode/schemas/qlinter.schema.json`](../editors/vscode/schemas/qlinter.schema.json)
is the same as a JSON Schema.

## The dependency graph

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
See [cli.md](cli.md#the-dependency-graph-qlinter-analyze-graph) for what
counts as an edge.
