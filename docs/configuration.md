# Configuration

## Where it is found

For each file, qlinter walks up from the file's directory and uses the first
of `.qlinter.toml`, `qlinter.toml`, or a `pyproject.toml` with a
`[tool.qlinter]` table. A `pyproject.toml` without the table is passed over.
The nearest file wins, so a sub-project can carry its own. With none,
`~/.config/qlinter/qlinter.toml` (or `$XDG_CONFIG_HOME/qlinter/`) applies,
its patterns relative to the directory qlinter runs in.

`--config FILE` uses one file for everything, `--isolated` ignores them
all, and `--show-settings PATH` prints which file governs a path, the
`target-version` in force and the rules that report there. The language server finds each document's configuration
the same way and re-reads it when it changes.

## Keys

| key | value |
|---|---|
| `profile` | `general`, `style`, `styleq` or `uqf` |
| `select` | codes or prefixes; replaces the profile's set |
| `extend-select` | codes or prefixes added to what is selected |
| `ignore` | codes or prefixes dropped |
| `per-file-ignores` | `{ "glob" = ["CODE", ...] }` |
| `exclude` | globs of files a directory walk skips; replaces the default list |
| `extend-exclude` | globs added to `exclude` |
| `extend` | another configuration file to inherit and override |
| `target-version` | `3.6`, `4.0`, `4.1` or `kdbx` ([version check](cli.md#the-q-version-check)) |
| `baseline` | a baseline file, relative to this one ([baselines](cli.md#baselines)) |
| `required-version` | the qlinter releases allowed, e.g. `">=0.40, <0.41"` |
| `[severity]` | code or prefix to `error`, `warning`, `information` or `hint` |
| `[rules.CODE]` | a rule's own options |

The rule keys (`select`, `extend-select`, `ignore`, `per-file-ignores`) and
the two tables may also go under `[lint]`. In `pyproject.toml` everything
goes under `[tool.qlinter]` and `[tool.qlinter.lint]`.

An unknown key, a value of the wrong kind, or a selector that names no rule
is an error (exit 2), so a typo cannot quietly do nothing. The language
server uses the defaults instead and shows the error once.
[`editors/vscode/schemas/qlinter.schema.json`](../editors/vscode/schemas/qlinter.schema.json)
is the same set of keys as a JSON Schema, and a test keeps the two equal.

### Selecting rules

The command line wins over the file: `--profile`, then `--select`,
`--extend-select` and `--ignore` applied after it. As in Ruff, the most
specific selector wins, so `ignore = ["QS"]` with
`extend-select = ["QS001"]` keeps QS001 alone. `ALL` names every rule.

Under `uqf`, QP002, QP003, QP005 and QP007 skip files in a `tests`
directory below the configuration's directory, since a test may build a
datetime or read the local clock on purpose. Selecting one by its own code
(`--select QP002`) reports it there anyway; a prefix such as `QP`, like
`ALL`, leaves the exemption standing.

### Severity

```toml
[severity]
QS = "information"   # every style rule, reported but not failing the run
QS006 = "warning"    # except this one
```

The longest matching code or prefix wins. Only `error` and `warning` fail
the run. Severity changes how a finding is reported, never whether; that is
`select` and `ignore`. An editor's `lint.severity` overrides it again.
`QLS001` sets the severity of every qls finding.

### Rule options

| rule | option | default |
|---|---|---|
| QS006 | `max-lines`: lines of code a lambda may have | 25 |
| QL001 | `markers`: words reported in a comment | `TODO`, `FIXME`, `XXX`, `HACK` |
| QX002 | `name-pattern`: case-insensitive regex on a name's last part | `(?:password\|passwd\|pwd\|secret\|token\|api_?key\|credentials?)$` |

```toml
[rules.QS006]
max-lines = 40
```

### Required version

`required-version` takes comma-separated clauses of `==`, `!=`, `>=`, `<=`,
`>`, `<` or `~=` (`~=0.33.1` is `>=0.33.1, <0.34`), or a bare version that
must match exactly. Any other qlinter refuses to run (exit 2), so CI and
every checkout agree on the findings.

### Inheriting

`extend = "../qlinter.toml"` reads another file first. A key the extending
file sets replaces the base's, `exclude` and `per-file-ignores` included;
only `extend-exclude` adds. `[severity]` and `[rules.CODE]` are overridden
one entry at a time.

## Exclude patterns

`exclude`, `extend-exclude`, `--exclude` and the keys of
`per-file-ignores` are globs read the way Ruff reads them, with the same
glob crate: `*` and `?` match a `/` too, `[a-z]` and `[!a]` (or `[^a]`) one
character, `{gen,vendor}` either name, and `\` escapes (on Windows write
`[*]`). A pattern that does not parse, `[bad`, is a configuration error.

- A pattern with a `/` anywhere (`lib/`, `./lib`, `src/gen/*.q`) is anchored
  at the configuration's directory, or the current directory for
  `--exclude`. So `lib/` excludes the root's `lib` and not `tests/lib`.
- A pattern with no `/` (`lib`, `*_gen.q`) matches at any depth.
- A pattern that names a directory covers everything under it.

Until a configuration sets `exclude`, a walk skips `.git`, `.venv`,
`node_modules`, `__pycache__`, `build`, `dist` and `target` at any depth.
`exclude = []` walks them all.

Exclusions decide which files a directory walk visits. A file named on the
command line is linted anyway unless `--force-exclude` is given, and the
language server lints every document the editor opens.

## Suppressing a finding

```q
endofday:{[dt;data] dt} / noqa: QF016 TorQ's fixed signature
/ qlinter: noqa: QS001, QF016 reason
```

A trailing `/ noqa: CODE` accepts that code on its line. Several codes are
separated by commas or spaces, and text after them is a reason. A bare
`/ noqa` names nothing and suppresses nothing. A comment line at the left
margin, `/ qlinter: noqa: CODES`, accepts the codes on every line of its
file. Findings from qls ignore both.

A `noqa` code that suppresses nothing is reported as QL003 (`style` and
above), and its fix removes it. `qlinter --add-noqa` writes a `noqa` for
every current finding; a line no comment can follow, such as one inside a
string or a block comment, is left alone.
