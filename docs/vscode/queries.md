# q processes and queries

Managing processes, running code on them, inspecting them, and debugging, profiling and testing. The file formats and connection details are in [processes.md](processes.md). The [extension README](../../editors/vscode/README.md#get-started) has the setup steps.

## Processes

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
[docs/vscode/processes.md](processes.md).

## Running code

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

## Inspecting a process

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

## Debugging, profiling and testing

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
