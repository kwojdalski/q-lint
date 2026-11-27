# Agents, the local q, settings and troubleshooting

The remaining parts of the q-lint extension: chat and agent tools, the local q, the settings most people change, troubleshooting and building it. The [extension README](../../editors/vscode/README.md) has the summary.

## Agents and chat

- Language-model tools for Copilot and other agents: **Run q Query**
  (`#qQuery`, which you confirm before each call), **List q Tables**
  (`#qTables`) and **Lint q Code** (`#qLint`).
- **@q** in the chat explains q code (`/explain`) or a q error (`/error`).
- **Draft qSQL from a Description** drafts a query in a new editor; it runs
  only if you choose Run.

## The local q

- **Select q Interpreter** (or the status bar item) picks the q that
  terminals, **Start Process** and tasks use, from `~/.kx`, `QHOME`, `PATH`
  and the workspace. q-lint warns when that q's licence is close to
  expiry; **Check q Licence Expiry** checks it now.
- The workspace's `.env` (`q-lint.env.file`) is given to every q the
  extension starts.
- **Terminal > Run Task > q** offers **run current file** and a test task per test
  runner script; the `$q` problem matcher puts q's first error in Problems.
- **Add q Dev Container Configuration** writes a `.devcontainer/` that
  installs KDB-X, after showing it to you.

## Settings

Search **q-lint** in VS Code's Settings, or run **Open q-lint Settings**,
to see every setting with its description. The ones most people change:

| setting | default | what it does |
|---|---|---|
| `q-lint.profile` | `style` | Which rules run: `general`, `style`, `styleq` or `uqf`. Overrides the repository's configuration. |
| `q-lint.lint.run` | `onType` | Lint on every change, or `onSave`. |
| `q-lint.lint.ignore` | `[]` | Rule codes or prefixes to hide in the editor. |
| `q-lint.completion.enable` | `false` | Complete locals, workspace names and q's words. |
| `q-lint.workspaceIndex.exclude` | `[]` | Globs the workspace index skips, such as `["vendor/**"]`. |
| `q-lint.serverPath` | empty | Your own `qlinter` binary instead of the bundled one. |
| `q-lint.query.mode` | `console` | Where results go: `console`, `grid` or `chart`. |
| `q-lint.query.resultsLocation` | `editor` | Show grids and charts beside the editor, or in the bottom `panel`. |
| `q-lint.query.gridLimit` | `10000` | Most rows sent to the grid or chart. |
| `q-lint.query.timeout` | `0` | Seconds before a query is aborted; `0` is no limit. |
| `q-lint.terminal.qBinary` | `q` | The local q for terminals, tasks and started processes. |
| `q-lint.processes.readOnlyGuard.tags` | `["prod","prd","production"]` | Tags whose processes the read-only guard protects. |

Each feature also has its own `enable` setting.

## Troubleshooting

- **Output → q-lint** names the server version and binary and shows its
  errors. After replacing the binary, run **Restart Server**.
- On macOS, VS Code started from the Dock does not see your shell's `PATH`:
  give `q-lint.serverPath` and `q-lint.terminal.qBinary` absolute paths.
- A gateway, or a TorQ process with permissions on, that refuses q-lint's
  queries: use **Set Process Evaluation** to make it `direct`.
- **List Affected Tests** and the other git features need a trusted folder
  in a repository with at least one commit.
- `q-lint.trace.server` logs the traffic between VS Code and the server.
- `qlinter --rules` lists every rule; `qlinter --explain <CODE>` explains
  one.
- The **Help and Feedback** view links these docs, the rule reference, and
  forms to report a bug or suggest a feature.

## Development

`server/` is not committed. `python3 scripts/dist.py build` builds the
release binary and copies it in before `vsce package`; by hand,
`cargo build --release && mkdir -p editors/vscode/server && install -m 755
target/release/qlinter editors/vscode/server/qlinter`. Without it, the
extension falls back to `qlinter` on `PATH`. The q grammar is generated:
`python3 scripts/q_grammar.py > editors/vscode/syntaxes/q.tmLanguage.json`.
