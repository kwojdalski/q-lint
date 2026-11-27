# q-lint for VS Code

Linting and language features for q/kdb+, from the
[q-lint](https://github.com/kwojdalski/q-lint) language server, plus
connections to q processes: run code, browse results in a grid or chart,
write q notebooks, and work with TorQ and HDBs from the editor.

![the q-lint icon](icon.png)

**The linter never runs your code.** Linting, navigation, hovers and
completion read the source and a catalogue of q's words that ships with the
server. Only the process features talk to q, and only to a process you add
and connect to. See [Safety](#safety).

Early version. A finding that looks wrong is worth an
[issue](https://github.com/kwojdalski/q-lint/issues).

## Features

- **Linting** as you type, with over 140 rules, profiles (`general`,
  `style`, `styleq`, `uqf`), Quick Fixes, `noqa` suppression, baselines and
  a problems dashboard.
- **Navigation**: outline, definition, references, rename, call hierarchy,
  hovers, signature help and inlay hints, read from the workspace without
  running it.
- **Editing helpers**: refactors, qSQL rewrites, snippets, folding, a
  cheat sheet and offline help for q builtins.
- **Processes**: add, tag and connect to q processes, run a line, selection,
  statement or file, and inspect namespaces, tables and functions.
- **Results** in a grid or chart: sort, filter, pivot, export, dashboards.
- **Debugging and testing**: logpoints, profiling, a Testing view for
  `test_*`, qUnit, `.qt` and k4unit suites, snapshots and coverage.
- **Notebooks** (`.qnb`), **TorQ** gateways, logs and tickerplants, **HDB**
  tools, and chat and agent tools.
- A **read-only guard** for production processes.

Every feature has its own `enable` setting. Off means hidden, unregistered
and sending nothing.

## Get started

1. **Install** the extension. On macOS (Apple Silicon and Intel), Linux x64
   and Windows x64 the `qlinter` binary is bundled. Elsewhere, take one from
   [releases](https://github.com/kwojdalski/q-lint/releases) and put it on
   `PATH` or in `q-lint.serverPath`.
2. **Open a `.q` file.** Findings appear as you type, in the editor and the
   Problems panel. A finding's code links to the
   [rule reference](https://github.com/kwojdalski/q-lint/blob/master/docs/rules.md).
3. **Add a process.** Start a q (`q -p 5000`), open the q-lint panel in the
   activity bar, and run **Add Process** in the Processes view: a label,
   host, port, TLS, an optional user and password (kept in VS Code's
   SecretStorage), and tags.
4. **Connect** by clicking the process. The status bar shows the connection.
5. **Run code**: `Ctrl+Q` runs the current line, `Ctrl+R` the selection,
   `Ctrl+E` the current statement, `Ctrl+F10` the file. Results appear in
   the **q-lint: query** output.
6. **See a table**: **Switch Query Mode** (or the mode in the status bar)
   sends results to a grid or chart instead.

**Get Started** opens a walkthrough of these steps, also on VS Code's
Welcome page.

To format q on save, or to apply the safe fixes on save without making
q-lint the formatter:

```json
"[q]": {"editor.defaultFormatter": "wojdalski.q-lint", "editor.formatOnSave": true}
"[q]": {"editor.codeActionsOnSave": {"source.fixAll.q-lint": "explicit"}}
```

A repository's `qlinter.toml` (or `[tool.qlinter]` in `pyproject.toml`) sets
the profile and rules, as for the command line; without a `profile` the
editor uses `style` where the command line uses `uqf`, so it shows fewer
findings than CI.

## Notebooks

A `.qnb` file is a notebook of q and Markdown cells, run on the active
connection. **New q Notebook** creates one; cells take directives such as
`/ @grid` and `/ @chart line`, and notebooks export to HTML, Jupyter and q.
Directives, the file format, the shell runner and git setup:
[docs/vscode/notebooks.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/notebooks.md).

## TorQ

Gateway queries through `.gw.syncexec`, TorQ and q logs merged by time and
followed live, tickerplant streaming and log replay, and views over
`.clients` and `.timer.timer`. A TorQ process with `.pm` on refuses
q-lint's lambda: **Set Process Evaluation** to `direct`. Details:
[docs/vscode/torq.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/torq.md).

## Safety

- **Read-only guard**: code sent to a process tagged `prod`, `prd` or
  `production` (`q-lint.processes.readOnlyGuard.tags`) is read first, and a
  modal asks before anything that would change the process. Code it reads
  as read-only runs under q's `reval`.
- **Restricted Mode**: in an untrusted folder, linting still works.
  Settings that name a program, the server's arguments or the guard come
  from your user settings only, and git is not run.

What counts as a write, the evaluation trade-offs and the full Restricted
Mode list:
[docs/vscode/safety.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/safety.md).

## Settings

Search **q-lint** in VS Code's Settings, or run **Open q-lint Settings**.
The ones most people change:

| setting | default | what it does |
|---|---|---|
| `q-lint.profile` | `style` | Which rules run: `general`, `style`, `styleq` or `uqf`. Overrides the repository's configuration. |
| `q-lint.lint.run` | `onType` | Lint on every change, or `onSave`. |
| `q-lint.lint.ignore` | `[]` | Rule codes or prefixes to hide in the editor. |
| `q-lint.completion.enable` | `false` | Complete locals, workspace names and q's words. |
| `q-lint.serverPath` | empty | Your own `qlinter` binary instead of the bundled one. |
| `q-lint.query.mode` | `console` | Where results go: `console`, `grid` or `chart`. |
| `q-lint.query.timeout` | `0` | Seconds before a query is aborted; `0` is no limit. |

The full table, with the rest, is in
[docs/vscode/extension.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/extension.md#settings).

## Troubleshooting

- **Output -> q-lint** names the server version and binary and shows its
  errors. After replacing the binary, run **Restart Server**.
- On macOS, VS Code started from the Dock does not see your shell's `PATH`:
  give `q-lint.serverPath` and `q-lint.terminal.qBinary` absolute paths.

More in
[docs/vscode/extension.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/extension.md#troubleshooting).

## Documentation

Every command, by area, is in
[docs/vscode/](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/README.md):
[features](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/features.md),
[queries](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/queries.md),
[processes](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/processes.md),
[results](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/results.md) and
[databases](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/databases.md).
The linter itself is documented in the
[q-lint README](https://github.com/kwojdalski/q-lint#readme).
