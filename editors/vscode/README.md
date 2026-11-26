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

- [Get started](#get-started)
- [Linting and language features](#linting-and-language-features)
- [q processes and queries](#q-processes-and-queries)
- [Results](#results)
- [Notebooks](#notebooks)
- [TorQ](#torq)
- [Databases and HDBs](#databases-and-hdbs)
- [Agents and chat](#agents-and-chat)
- [Safety](#safety)
- [The local q](#the-local-q)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)

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

## Linting and language features

### Linting

- **Profiles**: `general` reports only what q refuses; `style` adds likely
  mistakes; `styleq` adds published style guides; `uqf` adds one
  repository's conventions. A repository's `qlinter.toml` (or
  `[tool.qlinter]` in `pyproject.toml`) sets the profile and rules; see the
  [q-lint README](https://github.com/kwojdalski/q-lint#readme). With
  [Even Better TOML](https://marketplace.visualstudio.com/items?itemName=tamasfe.even-better-toml)
  installed, `qlinter.toml` gets completion and validation.
- **Quick Fixes** for over forty rules. The safe ones also run in bulk with
  `qlinter --fix`. **Suppress CODE on this line** and **Suppress CODE in
  this file** write a `noqa` comment instead.
- **Format Document** applies the safe fixes and nothing else; it is not a
  layout formatter. **Format Changed Lines** fixes only lines changed
  against git `HEAD` (on every save with
  `q-lint.formatChangedLines.enable`). **Lay out qSQL query on aligned
  lines** splits a long query, and `q-lint.qsqlLayout.onFormat` makes
  Format Document do it too.
- **Performance lints** (`QV`), **type lints** from inferred types, and a
  **q version check** (`QK`) for a folder's `target-version`.
- **Write Lint Baseline** records today's findings so only new ones show.
- **Show Problems Dashboard**: a folder's findings by rule and folder, and
  their trend over commits (**Problems Dashboard: Lint Earlier Commits**).
- **Show Dead Code Report**: workspace functions nothing reads.

To format q on save, or to apply the safe fixes on save without making
q-lint the formatter, use one of:

```json
"[q]": {"editor.defaultFormatter": "wojdalski.q-lint", "editor.formatOnSave": true}
"[q]": {"editor.codeActionsOnSave": {"source.fixAll.q-lint": "explicit"}}
```

Which rules report, in order: the profile (`q-lint.profile`, else the
configuration's, else `style`), then the configuration's `select` and
`ignore`, then `q-lint.serverArgs`, then `q-lint.lint.select` and
`q-lint.lint.ignore`, which can only narrow. The command line defaults to
`uqf`, so without a `profile` in the configuration the editor shows fewer
findings than CI.

### Navigation

- Outline, **Go to Symbol in Workspace**, **Go to Definition**, **Find All
  References** and **Rename Symbol** for locals and for globals across the
  workspace, read from every `.q` file without running it.
- **Show Call Hierarchy**, reference counts above each function, and `\l`
  paths as links. Renaming or moving a `.q` file rewrites the `\l` lines
  that load it.
- **q Dependencies** (Explorer view): the files the active file depends on
  and those depending on it. **List Affected Tests**: the tests that reach
  what changed against git `HEAD`. **q Namespaces** (Explorer view): every
  definition by namespace.
- Hovers and signature help for workspace functions and q builtins, inlay
  hints for parameter names and inferred local types, and the argument slot
  the cursor is in.
- Completion of locals, workspace names and q's words is off by default
  (`q-lint.completion.enable`), because VS Code then stops offering the
  words already in the file. `\l` paths complete regardless.

### Editing helpers

- Refactors in the lightbulb: **Extract function**, **Generate qDoc**,
  **Rewrite qSQL Query in Functional Form** and
  **Rewrite Functional Form as qSQL**. **Explain qSQL Query** (also on
  hover) says a query in words.
- **Organise Loads** (VS Code's **Organize Imports**) de-duplicates and
  sorts a run of `\l` lines.
- Enter after an open bracket indents the continuation line; dotted names
  (`.ns.f`) count as one word for Ctrl/Cmd+D; **Toggle Line Comment** on a
  blank line writes `/ .`, not a lone `/` that q reads as a block comment.
- Folding of lambdas, lists, brackets and block comments, and
  **Expand Selection** by q's structure. To fold by indentation instead:
  `"[q]": {"editor.foldingStrategy": "indentation"}`.
- Snippets for qSQL, iterators and control flow, and idiom snippets for the
  joins, `.z` handlers and a TorQ process. q fences in Markdown are
  coloured. `.k` and `.quke` files are coloured, not linted.
- **Convert Temporal Value** and a temporal hover;
  **Paste Spreadsheet Data as q Table**, **Paste JSON as q** and
  **Copy Value as JSON**; **Toggle Parameter Cache** (`Ctrl+Shift+'`) keeps
  a lambda's arguments as globals while you debug it.
- Help: **Show Help for q Builtin** (offline pages), runnable examples in
  hovers (**Try Example on Process**), the **q Cheat Sheet** view, and
  **Explain q Error** for the last failed query.

## q processes and queries

### Processes

The **Processes** view lists your processes, grouped and coloured by tag
(`prod` red, `uat` blue, `dev` green; **Edit Tag Color** for others).

- **Add Process**, **Edit Process**, **Delete Process**, **Tag Process**;
  **Import Processes** and **Export Processes** as JSON;
  **Add Many Processes...** from pasted lines or CSV;
  **Import Servers from qStudio...** and
  **Import Connections from KX Extension...**.
- **Add Discovery Server**: a URL that serves a process list. A committed
  `.qlint/processes.json` shares a team's list with everyone who opens the
  repository (**Add to Shared Process List**).
- Per process: **Set Connect Script** (q run on every connect),
  **Set SSH Tunnel**, **Set Credential Command** (for vaults and tokens),
  **Set Process Timeout**, **Set Gateway Server Types** (TorQ),
  **Set Process Evaluation** (wrapped or direct), and
  **Set Launch Definition** with **Start Process** and **Stop Process**
  for local processes.
- **Choose Connection for File** binds a file to a process.
  **New Query for Process** opens an editor bound to one.
  **Open Scratch Buffer** opens a per-process scratch file.

File formats, discovery, credentials and launch definitions:
[docs/vscode/processes.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/processes.md).

### Running code

| command | key |
|---|---|
| **Query Current Line** | `Ctrl+Q` |
| **Query Current Selection** | `Ctrl+R` |
| **Query Current Block** | `Ctrl+E` |
| **Execute Entire File** | `Ctrl+F10` |
| **Abort Current Query** | `Escape`, while a query runs |

- **Run** and **Run test** code lenses above each top-level function.
- `{{name}}` placeholders are asked for before a query runs.
- After **Query Current Line** or **Query Current Selection**, the result's
  short form shows at the end of the line.
- `q-lint.query.timeout` aborts a long query; **Toggle Unlimited Query**
  lifts the size limits until the window reloads. The status bar counts a
  running query's time, and you are notified when a long one ends.
- **Run Query Asynchronously** sends a query without blocking the
  connection. **Watch Query** reruns one every few seconds (off by
  default: `q-lint.query.watch.enable`).
- **Query a Tag** runs one query on every process with a tag and shows one
  table with a `process` column. **Compare Query Across Two Processes**
  shows two answers side by side with differences marked.
- **Copy Query Link** copies a `vscode://` link that opens the query for
  the recipient's process of the same label.
- **Query History** keeps every run (**Filter Query History**,
  **Export Query History**). **Saved Queries** keeps named queries per
  workspace (**Save Query**); **Add Scheduled Export...** runs one on a schedule to CSV,
  Parquet or Excel (off by default: `q-lint.export.schedule.enable`).
- **New SQL Query for Process** opens a `.sql` editor that runs on KDB-X's
  SQL engine (**Run SQL**).

Other ways to run code:

- **Code cells**: a `/ %%` line starts a cell. **Run Cell** (`Ctrl+Enter`),
  **Run All Cells**, **Run Cells Above** and **Run Cell and Below** run into
  the Interactive Window (**Open Interactive Window**).
- **Smart Send** (`Shift+Enter`, off by default) sends the statement and
  moves to the next.
- **Open q REPL Pane**: a console on the connected process, with history
  and completion.
- **Run Code from Terminal**, **Run File with Arguments...**,
  **Start q REPL**, **Send Current Line to Terminal** (`Ctrl+Shift+Q`),
  **Send Current Selection to Terminal** (`Ctrl+Shift+R`) and
  **Send Current Block to Terminal** (`Ctrl+Shift+E`) use a local q in a
  terminal.

### Inspecting a process

- **Process Explorer**: the connected process's namespaces, tables (with
  row counts and columns), functions and variables. **Preview** a table,
  **Table Templates...** for common queries, and **Show Schema Diagram**
  (**Save Schema Diagram as SVG**, **Copy Schema as Mermaid**).
- **Open Function Source** shows a function's live definition;
  **Edit and Redefine** and **Redefine on Process** send a changed one back.
  **Find Callers in Process** finds what calls it. **Check Drift Against
  Process** lists workspace functions that differ from the process (off by
  default).
- **Process Monitor**: memory, handles, timer, settings, version.
  **Connected Clients**, **Timers**, **System Settings** (with
  **Edit System Setting...**) and **Process Files** (the q host's files,
  read-only) are views of their own.
- **Diff Function Across Processes...**,
  **Diff Namespace Across Processes...** and **Find in Processes...**
  compare and search code across processes.
- Off by default, as each queries the process while you type or hover:
  live value hovers, live completion of process names and columns, process
  names in symbol search, and warnings for names neither the workspace nor
  the process defines.

### Debugging, profiling and testing

- Backtraces link to the failing line, in the output and in a terminal.
- **Add Logpoint** prints a function's arguments on each call without
  editing its file (**Show Logpoint Hits**, **Remove All Logpoints**).
  **Capture Locals at Last Error** reruns the last failed query and keeps
  the failing function's locals.
- **Time Lines on Process** times each statement. **Profile Functions on
  Process** times every function in a namespace, as a table and a flame
  chart. **Benchmark Expression** compares expressions with `\ts:N`.
- **Join Assistant...** writes the `lj`, `ij`, `aj`, `wj` or `uj` that two
  tables allow. **Explain aj Match...** shows which right-hand row an `aj`
  row matched, or why none did.
- **Testing view**: `test_*` and qUnit functions, `.qt` suites and k4unit
  CSV suites, run on the connected process. It has a **Coverage** profile,
  expected-against-actual diffs, **Re-run Failed q Tests**, snapshot tests
  (**Record Query Snapshot**, **Update Snapshot**) and
  **Generate Test Stub**.
- Hot reload on save sends changed definitions to the process (off by
  default: `q-lint.hotReload.enable`).

## Results

In grid or chart mode, results open beside the editor or in the
**q Results** panel (`q-lint.query.resultsLocation`). The process sends at
most `q-lint.query.gridLimit` rows.

- **Grid**: sort, filter, heatmap (**Toggle Result Heatmap**), column
  formats by name suffix (`_PCT`, `_BPS`, `_CCY` ...),
  **Add Conditional Format...**, data bars and sparklines, and a column
  layout you can move, hide and freeze. **Load More Result Rows** pages
  through a cut result (off by default: `q-lint.results.paging.enable`).
- **Other views of a result**: **Show Column Statistics**,
  **Show Result as Tree**, **Show Result as Pivot**,
  **Show Result Correlation Matrix** and
  **Compare Result with Previous Run**. Results stay as tabs
  (**Show Result from History**).
- **Charts**: line, bar, scatter, histogram, area, step and candles, a
  second y axis, order-book depth, a map for latitude and longitude, and
  linked panes. **Save Result Chart as Image** (PNG or SVG);
  **Save Result Chart with Query** remembers a chart for a query. Every
  chart is kept in the **q Plots** view (**Save Plot As...**).
- **Act on a result**: **Drill Down from Cell** runs a follow-up query you
  define in `q-lint.results.drilldownTemplates`; **Wrangle Result...**
  filters, sorts, renames and casts, and writes the q; **Edit Cell...**
  writes the `update` for a cell.
- **Export**: **Export Results to CSV**, **Export Results As...** and
  **Copy Results As...** (Excel, Parquet, JSON, Markdown, HTML, q),
  **Send Result to Notebook** and **Append Result to Markdown Report...**.
- **From code**: after **Define .qlint.view and .qlint.plot on Process**,
  `.qlint.view t` opens `t` in the grid and `.qlint.plot t` as a chart.
- **Data files**: **Open Data File in Grid** for a CSV, TSV or JSON file,
  and **Load CSV into q...** to build the load statement.
- **Dashboards**: **Open Dashboard...** shows saved queries as tiles;
  **Add to Dashboard...** adds one.
- **Render Chart from CSV or JSON File...** writes an SVG. The same works
  from a shell with the extension's `out/chartcli.js` (`--help`).

The grid works with a screen reader, and query outcomes are announced.

## Notebooks

A `.qnb` file is a notebook of q and Markdown cells, run on the active
connection. **New q Notebook** creates one.

- Directives on a cell's first lines: `/ @grid`, `/ @chart line` (with
  `/ @title` and `/ @height`), `/ @process <label>` and `/ @parameters`.
  **Set Notebook Row Limit** caps what a grid or chart shows.
- `{{q: expr}}` in Markdown shows a live value. The **Notebook Variables**
  view lists the process's globals.
- **Restart Notebook Process and Run All** restarts a process q-lint
  started and runs every cell.
- **Run Notebook with Parameters** writes a run to a new `.qnb`, HTML or
  Jupyter file. `out/qnbrun.js` does the same from a shell.
- **Export Notebook as HTML**, **Export Notebook as Jupyter Notebook**,
  **Export Notebook as q Script** and
  **Import Jupyter Notebook as q Notebook**.
- **Compare Notebook Cells...** diffs cells without their outputs.
  **Clear Notebook Outputs in File** and
  **Set Up Git to Strip Notebook Outputs...** keep outputs out of commits.

Directives, the file format, the shell runner and git setup:
[docs/vscode/notebooks.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/notebooks.md).

## TorQ

- **Gateway queries**: **Set Gateway Server Types** marks a gateway.
  Queries to it go through `.gw.syncexec` to the server types named by
  **Query Gateway on Server Types...**, else a file's
  `/ @servertypes rdb hdb` line, else the process.
- **Permissions**: a TorQ process with `.pm` on refuses q-lint's lambda;
  use **Set Process Evaluation** to make it `direct`.
- **Start Process** runs a TorQ process from a launch definition.
- **Logs**: **Open Log File...** reads TorQ and q logs, merged by time and
  followed live. Filter with **Filter Log by Level...**,
  **Filter Log by Process...**, **Filter Log by Time...** and
  **Filter Log by Text...**.
- **Tickerplants**: **Stream Tickerplant Table** (off by default:
  `q-lint.tickerplant.stream.enable`), the **Tickerplant Subscribers** view,
  and **Open Tickerplant Log...** to inspect and replay a log in a separate
  q.
- The **Connected Clients**, **Timers** and **Process Monitor** views read
  TorQ's `.clients` and `.timer.timer` where present.

Details: [docs/vscode/torq.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/torq.md).

## Databases and HDBs

- **HDB Browser** (view): a loaded partitioned database's partitions, row
  counts per table and partition, segments and sym file size, read without
  loading data. Under a `.Q.view` it says the figures cover N of M
  partitions.
- **Check Partition Consistency**: missing dates, tables and columns, type
  differences and enumeration problems across partitions.
- **Inspect Sym File**: size, growth and the columns that use it most.
- **Manage HDB Column...**: add, delete, rename or cast a column, or set its
  attribute, in every partition. The script opens for review first.
- **Advise Attributes**: whether `s#`, `u#`, `p#` or `g#` would help each
  column.
- **Document Database**: tables, columns, keys, partitions and functions as
  one document.
- **Write Schema Migration...**: the q that turns one table's schema into
  another's. **Generate Test Data...**: random rows shaped like a table.

## Agents and chat

- Language-model tools for Copilot and other agents: **Run q Query**
  (`#qQuery`, which you confirm before each call), **List q Tables**
  (`#qTables`) and **Lint q Code** (`#qLint`).
- **@q** in the chat explains q code (`/explain`) or a q error (`/error`).
- **Draft qSQL from a Description** drafts a query in a new editor; it runs
  only if you choose Run.

## Safety

- **Read-only guard**: code sent to a process tagged `prod`, `prd` or
  `production` (`q-lint.processes.readOnlyGuard.tags`) is read first, and a
  modal asks before anything that would change the process. Code it reads
  as read-only runs under q's `reval`, so a write it missed is refused.
- **Wrapped and direct evaluation**: q-lint normally sends code inside a
  small lambda, which gives backtraces, q's formatting and `reval`. For a
  process that refuses a lambda, **Set Process Evaluation** to `direct`
  (or **Toggle Unwrapped Query** for every process) sends plain strings.
- **Restricted Mode**: in an untrusted folder, linting still works.
  Settings that name a program, the server's arguments or the guard come
  from your user settings only, the folder's `.env` and q binaries are
  ignored, and git is not run.
- **Feature switches**: every feature has its own `enable` setting. Off
  means hidden, unregistered and sending nothing. Features that act on
  their own are off by default.

What counts as a write, the evaluation trade-offs and the full Restricted
Mode list:
[docs/vscode/safety.md](https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/safety.md).

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
