# q-lint for VS Code

Linting, Quick Fixes, navigation and syntax colouring for q/kdb+, as you
type, from the [q-lint](https://github.com/kwojdalski/q-lint) language
server - and connections to q processes, to run code on them from the
editor.

![the q-lint icon](icon.png)

**Why another linter?** I wasn't satisfied with the solutions available for
q, so I decided to build my own, inspired by the best practices of linters
for other languages, such as [Ruff](https://docs.astral.sh/ruff/) for Python.

**Early version.** Open source, built to be good enough for agentic
development, and already catching the most common problems. A finding that
looks wrong is worth an [issue](https://github.com/kwojdalski/q-lint/issues).

**The linter never executes your code**, which is why it is safe on every
keystroke. Navigation, hovers, signature help and completion are read from
the source the same way, and from a catalogue of q's own words that ships
with the server: none of them asks a running q anything. The one thing that
does is the [q processes](#q-processes-and-queries) panel: it connects only
to a process you add and connect to, and sends only the code you run.

## Features

- **Diagnostics** for what q would refuse, plus likely mistakes and style
  conventions, depending on the profile. A finding's code, in the Problems
  panel and on hover, links to that rule in the
  [rule reference](https://github.com/kwojdalski/q-lint/blob/master/docs/rules.md).
- **Quick Fixes** for over forty rules, among them operators and keywords
  from other languages (`==`, `&&`, `+=`, `true`, `return`), invalid string
  escapes, symbols where q wants strings, `f(a;b)` calls, one-row tables,
  dead code, unused locals, comparisons a where phrase groups wrongly, and
  a nested lambda reading its parent's local.
  Those that cannot change a working program also run in bulk with
  `qlinter --fix`; `--unsafe-fixes` adds the rest.
- **Suppress CODE on this line**, a Quick Fix on every finding that writes
  `/ noqa: CODE` after its line, or adds the code to the `noqa` already
  there. It is missing where no such comment would be read as one - a line
  that ends inside a string, a system command, a block comment, a file whose
  brackets do not close - and it is never the preferred fix.
- **Format Document** applies the fixes `qlinter --fix` makes - those that
  cannot change a working program - and nothing else: it is not a
  whitespace or layout formatter, and it never applies an editor-only fix.
  The same edit is the code action `source.fixAll.q-lint`, to
  [run on save](#formatting) beside another formatter.
- **Folding** of lambdas, parenthesised lists, bracketed blocks and block
  comments that span lines, read from the brackets and never from one inside
  a string or a comment. See [Folding](#folding) for what that replaces.
- **Snippets** for the forms q is mostly written in: qSQL (`select`,
  `selectby`, `update`, `updateby`, `exec`, `execby`, `delete`,
  `deletecols`, and the functional `fselect` and `fupdate`), protected
  evaluation (`trap`, `trapn`), the iterators (`each`, `peach`, `eachboth`,
  `eachleft`, `eachright`, `eachprior`), control flow (`cond`, `condn`,
  `if`, `do`, `while`), a function under a qdoc header (`fn`) and a `\d`
  block (`namespace`).
- **Syntax colouring** from a TextMate grammar, plus semantic tokens: a
  function is coloured wherever it is called, even when another `.q` file in
  the workspace defines it, and a parameter wherever its body reads it.
  Unused parameters and locals are faded.
- **Navigation**: the outline and breadcrumbs, **Go to Symbol in Workspace**,
  **Go to Definition** and **Find All References** across the workspace's
  `.q` files, and occurrence highlights that tell a write from a read. A
  name is resolved as q resolves it under the `\d` context in force,
  including in a file another loads under a context. What only running the
  code would tell - a name built at run time, `value "..."`, another
  process - is not found.
- **Rename** for a lambda's parameters and locals. A global is refused with
  the reason: it can be reached from a string, a symbol or another process,
  and a rename that misses one of those breaks the program quietly.
- **Hover** on a name the workspace defines shows its parameters, the
  comment written above its definition and the file it is in; on a word of
  q itself - `ssr`, `select`, `.z.p`, `.Q.s` - how it is written, what it
  gives, and a link to its page in the KX reference.
- **Signature help** inside `name[`: the parameters, with the one being
  written marked, for a workspace function or a q function called with
  brackets.
- **Completion**, when turned on with `q-lint.completion.enable`: a lambda's
  parameters and locals first, then the names the workspace defines, spelled
  as the `\d` context in force reads them, then q's own words. It does not
  know a table's columns or anything only a running process holds.
- **Call hierarchy** (**Show Call Hierarchy**, **Peek Call Hierarchy**) on a
  global function: the definitions and files that name it, and the workspace
  functions its own definition names. It is read from the names, so a
  function passed as a value (`f each x`) counts as called, and one called
  through a string or from another process is not listed. A name at a
  script's top level is listed under the file.
- **q Dependencies**, a view in the Explorer: the files the active q file
  depends on - it loads them or reads a name they define - and the files
  depending on it, as `qlinter analyze graph` prints them. It also lists the
  lines where the file reaches a name computed at run time, which the graph
  cannot follow. Choosing a row opens the file. It follows the active editor
  and is redrawn after a save; the button in its title redraws it now.
  **q-lint: Show Dependencies** opens it.
- **q-lint: List Affected Tests**: the test files that reach a q file changed
  against git `HEAD` (uncommitted and untracked files, and buffers not yet
  saved), each with the changes it reaches. Choosing one opens it. It lists
  and never runs anything: running them is your test runner's job. A test
  file is a `.q` file named `test_*` or `*_test`, or under a `test` or
  `tests` directory. A changed file that was deleted or is excluded from
  the index cannot be followed, and the list says how many were.

## q processes and queries

The **q-lint** panel in the activity bar holds two views.

**Processes** lists the q processes you add, grouped by tag. Tags `prod`
(or `prd`), `uat` and `dev` are coloured red, blue and green. Click a
process to connect; the status bar shows the connection, and clicking it
switches. The commands:
- **Add**, **Edit** and **Delete Process**, and **Tag Process**. A password
  is kept in VS Code's secret storage, never in settings or in an export.
- **Connect to Process**, which also takes a process's label as an
  argument for a keybinding, and **Disconnect**.
- **Import** and **Export Processes**: a JSON file holding
  `{"processes": [{"label", "host", "port", "user"?, "tags"?, "tls"?}]}`.
  An import replaces processes of the same label, adds the rest, and says
  which entries it skipped.
- **Insert Active Connection Label**, at the cursor.

**Querying.** With a q file open:
- **Query Current Line**, `ctrl+q`.
- **Query Current Selection**, `ctrl+r`: the current line when nothing is
  selected.
- **Query Current Block**, `ctrl+e`: the statement the cursor is in, with
  its indented continuation lines.

The code is cut into statements by q's own script rules: a line starting
with a space or tab continues the one above, `/` lines and block comments
are skipped, and a `\` line is a system command. A closing `}` at column 0
starts a new statement, which q refuses, here as when it loads the file.
The statements run in order on the process, in its current `\d`, as its
console would run them, and nothing is defined on the process but what
your code defines. The result is formatted by the process at
`q-lint.output.consoleSize` and shown in the **q-lint: query** output with
the process and the time taken. An error shows q's message and, on kdb+ 3.5
and later, its backtrace. With no connection, a query asks which process to
connect to first.

**Abort Current Query** stops waiting at once. q has no message that cancels
a query, so the connection is closed and opened again; the process goes on
running the query, and the new connection is made once it is free.

**Query History** lists each query with its process, time, duration and
outcome; the button on a row runs it again on the active connection, and
**Clear Query History** empties it.

**q terminal.** With a q file open:
- **Run Code from Terminal**, in the editor's run menu: saves the file and
  starts `q-lint.terminal.qBinary` on it in a terminal named after the
  file, in the workspace folder. Running it again closes that terminal and
  starts a fresh q.
- **Send Current Line to Terminal**, `ctrl+shift+q`.
- **Send Current Selection to Terminal**, `ctrl+shift+r`: the current line
  when nothing is selected.
- **Send Current Block to Terminal**, `ctrl+shift+e`.

The code goes to the last q terminal q-lint started, and with none open a
new one starts `q-lint.terminal.qBinary` with no file. It is cut into
statements as a query is, and each statement is sent as one line, since q's
console reads one line per statement: its continuation lines are joined
with a space, as q joins them in a script, a trailing `/` comment is cut,
and a string that runs onto the next line keeps the newline as `\n`. A
`\d` line moves the console's namespace as it would a script's. The
terminal runs your shell, which starts q, so the code goes to whatever the
terminal is running: once q exits, it goes to the shell.

## q notebooks

A `.qnb` file opens as a notebook of q code cells and markdown cells. Its
cells run on the active connection - with none, the first run asks which
process to connect to - one at a time, in order, each numbered and timed.
A cell is cut into statements as a query is, and runs as one, defining
nothing on the process but what its code defines. A run of several cells
stops at the first that fails. Interrupting a cell does what **Abort
Current Query** does: q-lint stops waiting, and reconnects once the process
is free. Cells are not linted.

A cell's first lines can choose how its result is shown:
- `/ @console`, the default: the result as the process formats it, at
  `q-lint.output.consoleSize`. A value of `::`, such as an assignment
  ending in `;`, shows nothing, as in q's console.
- `/ @grid`: a table as an HTML table, coloured from the editor's theme,
  with a key column marked. At most 1,000 rows are sent, and the output
  says when the table was cut. Each value is sent as `string` writes it, so
  a timestamp keeps its nanoseconds.
- `/ @chart line`, `bar`, `scatter` or `histogram`: for now the table as
  text, with a note; charts come with query modes (#855).

They are q comments, so a cell runs the same as a query or in a script. A
directive q-lint does not know, or a chart of no known kind, fails the cell
with the directives it does know. An error shows q's message and, on kdb+
3.5 and later, its backtrace.

**Export Notebook as q Script**, on the notebook's toolbar and a `.qnb`
file's context menu, writes the code cells as a `.q` script q can load,
each markdown cell as a `/` ... `\` block comment. A cell's code runs from
the script as it ran in the cell: an indented first line is unindented, a
block comment a cell leaves open is closed, and a lone `\`, which ends a
cell, comments out the rest of it instead of ending the script.

The file is JSON, format 1:

```json
{
 "qnb": 1,
 "cells": [
  {"kind": "markdown", "source": ["# Prices"]},
  {"kind": "code", "source": ["/ @grid", "select from t"],
   "execution": {"order": 1, "success": true, "start": 1700000000000, "end": 1700000000012},
   "outputs": [{"items": [{"mime": "text/html", "text": "<table>...</table>"},
                          {"mime": "text/plain", "text": "..."}]}]}
 ]
}
```

`qnb` is the format version; a newer one than this extension reads is
refused with that said. `source` is the cell's lines. A code cell is q
unless it has a `language`. Outputs are saved, so a notebook reopens with
its results: an item is `text` when it is UTF-8 and `base64` otherwise.
`execution` holds the run's number, outcome and start and end, in
milliseconds since the epoch. Fields with nothing in them are left out, and
saving a notebook that was opened unchanged writes the same file. A file
that is not a notebook does not open: the editor says what is wrong with
it, and the file is left as it was. An empty file is a new notebook.

## Requirements

None on macOS (Apple Silicon and Intel), Linux x64 or Windows x64: the
matching `qlinter` binary is bundled. Elsewhere, take one from
[releases](https://github.com/kwojdalski/q-lint/releases) and put it on
`PATH` or in `q-lint.serverPath`.

## Settings

Every default is what the extension did before it had these settings. The
q-pro column names the setting of [q-pro](https://marketplace.visualstudio.com/items?itemName=jshinonome.vscode-q)
(`jshinonome.vscode-q`) that does the same job, where there is one.

| setting | default | what it does | q-pro |
|---|---|---|---|
| `q-lint.enable` | `true` | Run the language server. Off: syntax colouring only. | - |
| `q-lint.serverPath` | empty | Your own `qlinter` binary. Empty uses the bundled one, then `qlinter` on `PATH`; set, it always wins. | - (q-pro runs `qls` from `PATH`) |
| `q-lint.serverArgs` | `[]` | Extra `qlinter --lsp` arguments, after the ones the settings produce. They keep their command-line meaning, so `--extend-select` here can widen the repository's selection. | - |
| `q-lint.profile` | unset | `general`: only what q refuses. `style`: also likely mistakes. `styleq`: also published style guides. `uqf`: also one repository's conventions. Unset, a repository's `qlinter.toml` decides, and `style` applies without one. | - |
| `q-lint.configFile` | empty | One configuration file for every document instead of the nearest `qlinter.toml` (`--config`); relative to the first workspace folder. | - |
| `q-lint.lint.select` | `[]` | Show only these rule codes or prefixes, among those the configuration turns on. Narrows, never widens. | - |
| `q-lint.lint.ignore` | `[]` | Hide these rule codes or prefixes. | - |
| `q-lint.lint.run` | `onType` | `onType` lints every change; `onSave` lints on open and save. | - |
| `q-lint.lint.severity` | `{}` | The severity shown, by code or prefix, longest wins: `{"QS": "hint"}`. Display only. | - |
| `q-lint.fixes.unsafe` | `true` | Offer the editor-only Quick Fixes (`--unsafe-fixes`) as well as those `--fix` applies. | - |
| `q-lint.format.enable` | `true` | Register **Format Document** (the safe fixes). | - |
| `q-lint.semanticTokens.enable` | `true` | Colour calls and parameter reads on top of the grammar. | - |
| `q-lint.navigation.enable` | `true` | Offer the outline, workspace symbols, definitions, references, highlights and local rename. Off when another q extension already navigates. | - |
| `q-lint.help.enable` | `true` | Show hovers and signature help, from the source and the built-in catalogue of q's words. | - |
| `q-lint.completion.enable` | `false` | Complete locals, workspace names and q's words. Off by default: an editor told a server completes stops offering the words already in the file. | - |
| `q-lint.callHierarchy.enable` | `true` | Offer the call hierarchy of a global function. | - |
| `q-lint.graph.enable` | `true` | Offer the **q Dependencies** view and **q-lint: List Affected Tests**. Off: the view is hidden and the server answers neither. | - |
| `q-lint.workspaceIndex.enable` | `true` | Read every workspace `.q` file at startup for the names it defines, up to 20,000 files or 500,000 directory entries. Off: only open files. | - |
| `q-lint.workspaceIndex.exclude` | `[]` | Globs, relative to the workspace folder, the index does not read: `["vendor/**"]`. | `q-lang-server.sourceFiles.ignoreGlob` |
| `q-lint.trace.server` | `off` | Log client-server traffic: `off`, `messages`, `verbose`. | `q-lang-server.trace.server` |

Changing any of them but `q-lint.trace.server` restarts the server.

### Which setting wins

For which rules report on a file, in order, each step applied to what the
one before left:

1. The profile: `q-lint.profile` if set, else the configuration's
   `profile`, else `style`.
2. The configuration - `q-lint.configFile` if set, else the nearest
   `.qlinter.toml`, `qlinter.toml` or `pyproject.toml` `[tool.qlinter]`, else
   `~/.config/qlinter/qlinter.toml` - with its `select`, `extend-select`,
   `ignore` and `per-file-ignores`.
3. `q-lint.serverArgs`: `--select`, `--extend-select` and `--ignore` there
   act as on the command line.
4. `q-lint.lint.select` and `q-lint.lint.ignore`, which can only turn a
   rule off. Between the two, the longest code or prefix that names a rule
   decides, as in the configuration.

So with no editor settings the editor shows what `qlinter` prints in a
terminal and in CI only when the configuration names a `profile`: without
one the server's default is `style`, while the command line's is `uqf`, and
the editor shows fewer findings than CI. `q-lint.profile`, `q-lint.configFile` and
`q-lint.serverArgs` replace parts of the repository's configuration;
`q-lint.lint.*` only narrows it. `q-lint.lint.severity` changes how a finding
looks, not whether it is reported. Neither the configuration's `exclude` nor
`q-lint.workspaceIndex.exclude` hides diagnostics on a file you open.

### Query settings

None of these reaches the language server, and changing one restarts
nothing.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.output.consoleSize` | `"50 160"` | Height and width a result is formatted to, by the process. A larger result is cut there before it is sent. | `q-output.cfg.consoleSize` |
| `q-lint.output.autoClear` | `false` | Clear the output before each result. | `q-output.cfg.autoClear` |
| `q-lint.output.includeQuery` | `false` | Show the code above its result. | `q-output.cfg.includeQuery` |
| `q-lint.output.ignoreNullReturn` | `false` | Show nothing when the value is `::`. | `q-output.cfg.ignoreNullReturn` |

### Terminal settings

Read when a q terminal starts, so a change applies to the next one. None
reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.terminal.qBinary` | `"q"` | The q binary a terminal starts: a name on `PATH` or a path. It is quoted for the terminal's shell (POSIX, PowerShell or cmd), so it names one program, not a command with arguments. | `q-terminal.cfg.qBinary` |
| `q-lint.terminal.envPath` | `""` | A file of `NAME=value` lines set for q, such as `QHOME` and `QLIC`. They go on the command line that starts q (`NAME=value q`, `$env:NAME=` in PowerShell, `set` in cmd), so they win over what your shell's startup files set, and show there. Relative to the workspace folder. It is read, not run as a shell script as q-pro's is: `#` lines are comments, `export ` is allowed, quotes around a value are dropped, and nothing is expanded: `$HOME` stays `$HOME`. | `q-terminal.cfg.envPath` |

### Not here, and why

q-pro's query mode and grid decimals, its process explorer and its
discovery server are not here yet: they come with the grid and the process
explorer (#852). `kuki` is not
planned. Its
`sourceFiles.includeGlob` is not mirrored either: the index reads every `.q`
file `qlinter .` would - less what the configuration's `exclude` skips - and
`q-lint.workspaceIndex.exclude` narrows it.

## Formatting

q-lint does not make itself the default formatter. To use it for q files, and
to apply its safe fixes on every save, add this to your `settings.json`:

```json
"[q]": {"editor.defaultFormatter": "wojdalski.q-lint", "editor.formatOnSave": true}
```

Leave out `editor.formatOnSave` to format only when you ask (**Format
Document**). A file with nothing to fix, or whose brackets or strings do not
close, is left as it is.

To apply the same fixes on save without making q-lint the formatter - where
another extension formats q, or nothing should - ask for its fix-all code
action instead:

```json
"[q]": {"editor.codeActionsOnSave": {"source.fixAll.q-lint": "explicit"}}
```

`"source.fixAll": "explicit"` runs it too, with every other extension's.
`q-lint.format.enable` does not turn this off: it says whether q-lint is a
formatter, and this runs only where you list it.

## Folding

A lambda, a parenthesised list, a bracketed block (`if[...]`, `$[...]`, an
argument list) and a block comment each fold from the line they open on to
the line they close on. A closing bracket with more code after it on its
line keeps that line in view.

VS Code folds by indentation until a language server says it folds, and by
the server's ranges after. So a statement continued over indented lines with
no bracket open - a long qSQL `select`, say - folded before and does not
now, and while a bracket is unclosed nothing folds. To have the indentation
folding back for q:

```json
"[q]": {"editor.foldingStrategy": "indentation"}
```

## Repository settings

A `qlinter.toml` at the repository root (or `[tool.qlinter]` in
`pyproject.toml`) sets the profile, the rules and the exclusions for every
file beneath it, the way Ruff's configuration does; editing it re-lints the
open files. See the [configuration
docs](https://github.com/kwojdalski/q-lint#configuration).

## Troubleshooting

Open **Output → q-lint**: the first line names the server version and binary,
and the server's errors land there. After replacing the binary, run
**q-lint: Restart Server**. On macOS, apps started from the Dock do not see
your shell's `PATH`, so give `q-lint.serverPath` an absolute path.

**q-lint: List Affected Tests** runs `git` - VS Code's `git.path` when you
set one, else the one on `PATH` - in each workspace folder, so it needs the
folder to be in a repository with at least one commit, and a trusted
workspace. A git that has not answered in 30 seconds is stopped. What
changed inside a submodule is not listed: git names the submodule, not the
files in it. With `q-lint.workspaceIndex.enable` off, the dependencies and the
tests are only those among the files you have open.

`qlinter --rules` lists every rule; `qlinter --explain <CODE>` explains one.

## Development

`server/` is not committed, so a package never carries a server older than
the tree under the same version (#558). Packaging puts one there:
`python3 scripts/dist.py build` builds the release binary and copies it in
before `vsce package`, and the release workflow unpacks each platform's.
By hand: `cargo build --release && mkdir -p editors/vscode/server && install
-m 755 target/release/qlinter editors/vscode/server/qlinter`. Without one, the
extension falls back to `qlinter` on `PATH`. The grammar is generated:
`python3 scripts/q_grammar.py > editors/vscode/syntaxes/q.tmLanguage.json`.
