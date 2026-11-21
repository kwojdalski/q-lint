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
- **`.k` and `.quke` files are coloured, not linted.** A `.k` file is k, the
  language q is written in: comments, strings, symbols, numbers and temporal
  literals, the adverbs `' / \ ': /: \:` and `\` system commands. A `.quke`
  file is a [qcumber](https://code.kx.com/developer/qcumber/) spec:
  `feature`, `should`, `expect`, `bench` and the other keywords as
  structure, and the code under each block coloured as q. The linter has
  nothing true to say about either - k is not q, and a spec is not a script
  q loads - so only `.q` files reach the server, and opening one of these
  starts nothing.
- **Navigation**: the outline and breadcrumbs, **Go to Symbol in Workspace**,
  **Go to Definition** and **Find All References** across the workspace's
  `.q` files, and occurrence highlights that tell a write from a read. A
  name is resolved as q resolves it under the `\d` context in force,
  including in a file another loads under a context. A name several
  scripts assign goes first to the current file's own assignment, then to
  those in files it loads; the outline groups names by namespace; and Go to
  Definition on the path in `\l path/file.q` opens that file. What only
  running the code would tell - a name built at run time, `value "..."`,
  another process - is not found.
- **Rename** for a lambda's parameters and locals. A global is refused with
  the reason: it can be reached from a string, a symbol or another process,
  and a rename that misses one of those breaks the program quietly.
- **Hover** on a name the workspace defines shows its parameters, the
  comment written above its definition and the file it is in; on a word of
  q itself - `ssr`, `select`, `.z.p`, `.Q.s`, `.h.hy`, or a glyph such as
  `#` or `/:` - how it is written, what it gives, and a link to its page in
  the KX reference.
- **Signature help** inside `name[` (or `name [`): the parameters, with the
  one being written marked, for a workspace function, an alias or projection
  of one - showing the slots it leaves open - or a q function called with
  brackets. Past the last parameter none is marked, and it says the call has
  too many arguments.
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

The **q-lint** panel in the activity bar holds four views: Processes,
Process Explorer, Query History, and Help and Feedback.

New to it? **q-lint: Get Started** opens the walkthrough, also listed on
VS Code's Welcome page: see a lint finding, add a process, connect and run
a query, open the Process Explorer, switch to the grid, and try a notebook.
Each step's button runs the real command, and the step is ticked once you
have done it.

**Processes** lists the q processes you add, grouped by tag. Tags `prod`
(or `prd`), `uat` and `dev` are coloured red, blue and green, and
`q-lint.processes.tagColors` colours any tag, or overrides those. A process
takes its most cautious tag's colour: red, orange, yellow, blue, purple,
then green. Click a process to connect; the status bar shows the connection,
and clicking it switches. The commands:
- **Add**, **Edit** and **Delete Process**, and **Tag Process**. Add and
  Edit ask for a label, host and port; **TLS**, yes or no (yes for a process
  started with `-E 1` or `-E 2`; Edit offers the current choice first, so
  Enter keeps it); then authentication: a user, and, when there is one, that
  user's password. The password is kept in VS Code's SecretStorage, never in
  settings or in an export; on Edit, an empty password keeps the stored one,
  and clearing the user forgets it. Last come the tags.
- **Edit Tag Color**, on a tag row: one of the chart colours, or `default`
  to go back to the built-in colour (or none). It is written to your user
  settings, as the process list is kept per user and the colour should follow
  the tag into every workspace - unless the workspace settings already set
  `q-lint.processes.tagColors`, which would hide a user-level change, and
  then it is written there.
- **Connect to Process**, which also takes a process's label as an
  argument for a keybinding, and **Disconnect**.
- **Import** and **Export Processes**: a JSON file holding
  `{"processes": [{"label", "host", "port", "user"?, "tags"?, "tls"?}]}`.
  An import replaces processes of the same label, adds the rest, and says
  which entries it skipped.
- **Insert Active Connection Label**, at the cursor.
- **Copy Label for Agent Query**, on a process row: the label an agent's
  query names the process by (`server/label` for a discovered one).

**Discovery servers** list processes so a desk's need not be typed in by
hand. A discovery server is a URL that answers a `GET` with the same JSON as
an import: a list of processes, or `{"processes": [...]}`. Its processes are
shown under it, in a **Discovery Servers** group at the bottom of the view,
and connect like any other. They are kept in memory only, never saved to
disk. The commands:
- **Add**, **Edit** and **Delete Discovery Server**: a label and a URL, and
  an optional auth header kept in VS Code's secret storage. It is sent as
  `Authorization` (`Bearer <token>`, `Basic <base64>`), or, written as
  `Name: value`, under its own name. **Add Discovery Server** also takes
  `{"label", "url", "secret"?}` as an argument, and **Edit** a server's
  label and those fields.
- **Reload Discovery Server**: fetch it now; given no server - from the
  view's menu or the palette - fetch them all. Each is also fetched when it
  is added or edited, and at startup and every
  `q-lint.discovery.refreshInterval` minutes unless that is `0`.
- **Download Processes**: save a server's processes to the list. One whose
  label a saved process has is skipped and named, never replaced.
- **Remove Processes**: drop a server's processes from the view. The
  periodic fetch leaves it alone until it is reloaded.

A fetch waits 10 seconds at most, and takes only a 2xx `application/json`
answer of 5 MB or less, read as UTF-8 or the charset it names. It follows
up to 20 redirects, and sends the auth header only to the server's own
origin. Why one failed - no answer, a status, the wrong
content type, too large, not JSON - shows under the server's row, as do the
entries it skipped and why; nothing pops up.

A discovered process may share a label with a saved one, or with one another
server lists. Its row shows its own label, but once connected it is
`server/label` - in the status bar, the query history, and **Connect to
Process**'s argument - so the two are never taken for each other. A bare
label names a saved process first, then a discovered one if only one server
lists it. A discovered process with a `user` asks for its password on the
first connect, and keeps it in secret storage under `server/label`; one
that fails to connect is forgotten, and asked for again on the next.

**Querying.** With a q file open:
- **Query Current Line**, `ctrl+q`.
- **Query Current Selection**, `ctrl+r`: the current line when nothing is
  selected.
- **Query Current Block**, `ctrl+e`: the statement the cursor is in, with
  its indented continuation lines.
- **Execute Entire File**, `ctrl+f10`, also in the editor's run menu: the
  whole file as one query, cut into statements as a block is. `ctrl+f10` is
  in none of VS Code's default keybindings on macOS, Windows or Linux; the
  keys KX's extension uses, `ctrl+d` and `ctrl+shift+d`, are VS Code's "add
  next occurrence" and Run and Debug view, and a `ctrl+alt` key is AltGr on
  Windows, which types `ę`, `€` or `@` on many layouts.

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
connect to first. The output is coloured from the editor's theme: each
answer's `# process (n ms)` header, the error and its backtrace (each frame,
where it is and the caret under it), a table's rule and a keyed table's `|`,
numbers, symbols, temporal literals and strings, and an included query as q.

**Abort Current Query** stops waiting at once. q has no message that cancels
a query, so the connection is closed and opened again; the process goes on
running the query, and the new connection is made once it is free.

**Query History** lists each query with its process, time, duration and
outcome; the buttons on a row run it again on the active connection and
**Copy Query** copies its code, and **Clear Query History** empties it.

**Query controls.**
- **Toggle Unlimited Query**: while on, the console text is not cut at
  `q-lint.output.consoleSize`, and a grid or chart is sent every row, not
  `q-lint.query.gridLimit`. The status bar shows `unlimited`, and clicking
  it turns it off. It stays on until turned off, as q-pro's does, but only
  for the window: a reload turns it off, so a result sent whole is never
  left over from an earlier session. One cut q makes itself remains: KDB-X
  writes an atom or a list item with `-3!`, which stops at the process's own
  `\c` width, so a simple list (`til 100000`) is sent as its value and
  written out by q-lint instead, and a general list's long items are still
  cut at `\c`.
- **Toggle Unwrapped Query**, or `q-lint.query.unwrapped`: for a gateway
  that refuses a lambda, the code is sent as plain strings, one per
  statement in order, stopping at the first error, as a client that sends
  strings sends them; q-lint runs nothing of its own there. The process
  evaluates each as it evaluates any string (its `.z.pg`), so a `\d` lasts
  only for its own statement. The answer is whatever the process returns,
  formatted by q-lint: tables, keyed tables, dictionaries, lists and atoms
  as q's console writes them, and a table, dictionary or list reaches the
  grid and chart too. q-lint knows less than q does, so it is close but not
  exact: inside a table or a general list a symbol and a string are both
  shown as text, a timestamp is shown to the microsecond, and a function's
  text is not sent. Errors still come back as q errors, without a trace.
  The status bar shows `unwrapped`.
- **Query timeout**, `q-lint.query.timeout` seconds (`0`, the default, is
  none): a query still running then is aborted exactly as **Abort Current
  Query** aborts it, and the history records it as timed out.
- **Choose Connection for File** binds the active file to a process, kept
  per workspace, and takes a label as an argument for a keybinding. A query
  from that file (line, selection, block or entire file) switches the
  connection to its process first, connecting if nothing is connected -
  there is one connection at a time, so the file's process becomes the
  active one, and an unbound file then queries it too. The history, a
  rerun, Preview and notebooks use the active connection, never a binding.
  While the file's process is not the active connection, the status bar
  shows `file: <label>`. **Clear Connection for File** removes the binding.
- **Reveal Process** selects the connected process in the **Processes**
  view, and shows the view. **Open q-lint Settings** opens Settings at
  q-lint's.

Unlimited, unwrapped and the timeout apply to queries from the editor,
the history and Preview; a notebook cell runs as before.

**Parameter cache.** **Toggle Parameter Cache**, `ctrl+shift+'` (also in
the editor's context menu), is for running a lambda's body a line at a
time with real arguments. On the innermost lambda at the cursor it inserts
one statement, first in the body:

```q
f:{[a;b] a+b}   /  becomes
f:{[a;b].qlint.cache.p1a2b3c:(a;b);`a`b set'.qlint.cache.p1a2b3c; a+b}
g:{x*2}         /  becomes
g:{.qlint.cache.p4d5e6f:x;`x set .qlint.cache.p4d5e6f;x*2}
```

Run the definition (**Query Current Block**), call the function once, and
each parameter is then a global holding that call's value, so **Query
Current Line** or **Block** on a line of the body runs with them. The
parameters are the `[a;b]` list, or else `x`, `y` and `z` up to the highest
one the body reads. A lambda with none - `{[] ...}`, or a body that reads
no `x`, `y` or `z` - is left alone, and the command says so. When the `{`
line holds nothing after the parameters, the statement gets a line of its
own, indented as the body's next line so q still reads it as part of the
definition; otherwise it goes straight after the parameters. Toggling again
on the lambda removes exactly what was inserted, leaving the file as it was,
byte for byte. If the lambda names `.qlint.cache` in a form q-lint did not
insert, or one edited since (a parameter renamed, say), the command refuses
and leaves it for you to remove. While the active file holds a cached
lambda, the status bar shows `params cached`.

Inserting the statement changes only the file. Nothing happens on a process
until the instrumented code runs there - the definition loaded and the
function called - and only then does each call define globals on it: one
named after each parameter (`a`, `b`, `x`...), set with `set`, so in the
namespace current when the call runs, replacing any global of that name;
and `.qlint.cache.<id>`, holding the call's arguments, in the `.qlint.cache`
namespace. Toggling the statement off and loading the definition again stops
that, but does not delete the globals already defined. Do not leave it in
code that runs anywhere it matters.

**Query modes.** **Switch Query Mode** (or the mode in the status bar) picks
where a result goes; it sets `q-lint.query.mode`, and takes `console`,
`grid` or `chart` as an argument for a keybinding.
- **Console**, the default: every result in the **q-lint: query** output, as
  above.
- **Grid**: a table, a keyed table (unkeyed, its key columns shaded), a
  dictionary (as `key` and `value` columns; one keyed by a table as its
  key columns and a `value` column) or a list (as one `value` column) opens in the **q-lint: result** panel. Click a header to sort,
  type under it to filter (by the text shown, ignoring case). **Copy as
  CSV** copies the rows shown, in the order shown, and **Export to CSV**
  saves them to a file you pick; the command **Export Results to CSV** does
  the same, and takes the file's `Uri` as an argument to skip the dialog.
  In the CSV, a name, symbol or string a spreadsheet would run as a
  formula (`=`, `+`, `-` or `@` first, but not a number) starts with `'`.
  Each cell is what q
  prints in a table: a timestamp keeps its nanoseconds, a long above 2^53
  every digit, a null is blank and an infinity is `0W` or `0w`. Sorting is
  q's own order (`iasc` on the process), nulls first, and either way keeps
  equal values in their order, as `xasc` and `xdesc` do.
- **Chart**: the same results as a line, bar, scatter or histogram chart of
  the numeric columns against the first (a list against its row numbers),
  chosen in the panel; the panel's
  **Grid** and **Chart** buttons switch between the two for one result.

The panel opens beside the editor. With `q-lint.query.resultsLocation` set
to `panel`, results go instead to the **q Results** view in the bottom
panel, beside the terminal and the output, and the editor keeps the focus.
It is the same page as the editor's - the same grid, chart and buttons -
and keeps its view, sort and filters when the panel is hidden and shown
again.

The process sends at most `q-lint.query.gridLimit` rows, and the panel says
when a result was cut and how many rows it had. Anything that is not
tabular - an atom, a string, a function - and every error still goes to the
output. As in console mode, nothing is defined on the process: the rows are
shaped by the lambda sent with the query. The panel loads only the
extension's own files, under a Content-Security-Policy that allows no
inline script and no network. Its charts are drawn by
[Chart.js](https://www.chartjs.org) 4.5.1 (MIT), shipped in
`media/vendor/` with its licence.

**q terminal.** With a q file open:
- **Run Code from Terminal**, in the editor's run menu: saves the file and
  starts `q-lint.terminal.qBinary` on it in a terminal named after the
  file, in the workspace folder. Running it again closes that terminal and
  starts a fresh q.
- **Send Current Line to Terminal**, `ctrl+shift+q`.
- **Send Current Selection to Terminal**, `ctrl+shift+r`: the current line
  when nothing is selected.
- **Send Current Block to Terminal**, `ctrl+shift+e`.

**Start q REPL** starts `q-lint.terminal.qBinary` with no file in a new
terminal named `q`, with `q-lint.terminal.envPath`'s variables, in the
workspace folder; code is sent there from then on.

The code goes to the last q terminal q-lint started, and with none open a
new one starts `q-lint.terminal.qBinary` with no file. It is cut into
statements as a query is, and each statement is sent as one line, since q's
console reads one line per statement: its continuation lines are joined
with a space, as q joins them in a script, a trailing `/` comment is cut,
and a string that runs onto the next line keeps the newline as `\n`. A
`\d` line moves the console's namespace as it would a script's. The
terminal runs your shell, which starts q, so the code goes to whatever the
terminal is running: once q exits, it goes to the shell.

**Process Explorer** shows what the connected process holds: its
namespaces, the root first, less those in
`q-lint.processExplorer.excludedNamespaces`; under each, its tables with
their row counts and columns (key columns marked), its functions with their
parameters, and its variables with their type and count. A partitioned table
is not loaded to count it: its count is each partition's, from `.Q.cn`, and
the row says so; one it cannot count (a partition missing its directory) is
shown not counted. It is read in one call that defines nothing on the process,
on connect, on **Refresh Process Explorer**, and after each query when
**Toggle Process Explorer Auto Refresh** has turned
`q-lint.processExplorer.autoRefresh` on - never as you type. On a process
with thousands of names it reads 100 namespaces at most and the first 500
names of each, in sorted order, and says how many it left out. **Preview**,
on a table or a variable, runs its first `q-lint.processExplorer.previewLimit`
rows, or the variable, as a query. The explorer shares the query connection:
while a query runs it waits and refreshes after, and a query sent while it
reads waits for it.

**Help and Feedback** links to this README, the
[rule reference](https://github.com/kwojdalski/q-lint/blob/master/docs/rules.md),
**Report a Bug** and **Suggest a Feature** (a new GitHub issue, labelled
`bug` or `enhancement`) and the
[release notes](https://github.com/kwojdalski/q-lint/releases). Each opens in
your browser.

**Live completion.** While connected, completion in a q file adds the
process's global names, as read by the explorer, to the language server's,
and inside a qSQL statement - `select`, `exec`, `update` or `delete` ... `from
t` - the columns of `t` first. It adds nothing inside a string or a comment.

**Agents.** The **Run q Query** language-model tool (`q-lint_runQuery`,
`#qQuery` in a chat prompt) lets Copilot and other agents run a q query and
get the result as JSON. It takes `{"query", "process"?}`: without `process`
it runs on the active connection, and with none answers that nothing is
connected; with a process's label it connects to that process first, which
becomes the active connection, and an unknown label answers with the labels
there are. Before each call VS Code asks you to confirm, naming the process
and showing the query; for a process tagged `prod`, `prd` or `production`
it warns that the query runs on production. The query runs as **Query
Current Block** would, with the same lambda as grid mode, so nothing is
defined on the process but what the query defines. The agent gets:
- a table, keyed table, dictionary or list: `{columns, types, rowCount,
  data}`, `data` being the first 200 rows as arrays of values, with
  `truncated: true` when there were more and `keyColumns` for a keyed
  table. Booleans and numbers are JSON values and nulls `null`; a
  temporal, a symbol, a guid or a nested value is q's text, and so are a
  long above 2^53 and an infinity, so a timestamp keeps its nanoseconds;
- any other value: `{output}`, the process's text of it at
  `q-lint.output.consoleSize`;
- a failure: `{error, trace?}`.

A query running longer than `q-lint.agent.queryTimeout` seconds, or one the
agent cancels, is aborted as **Abort Current Query** aborts one, and the
agent is told so. Each agent query goes into **Query History**, marked
`agent`. The tool needs VS Code 1.95 or later; before it, only the command
is there.

## q notebooks

A `.qnb` file opens as a notebook of q code cells and markdown cells;
**New q Notebook** opens an untitled one, to save as a `.qnb` file. Its
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
  with a key column marked. At most `q-lint.notebook.rowLimit` rows (1,000)
  are sent - the table's first, or with `q-lint.notebook.rowLimitFrom` set
  to `last` its last - and the output says when the table was cut and
  which rows it shows. Each value is sent as `string` writes it, so
  a timestamp keeps its nanoseconds.
- `/ @chart line`, `bar`, `scatter` or `histogram`: a table, a keyed
  table, a dictionary or a list as a chart, drawn as query **Chart** mode
  draws it - the numeric columns against the first (a list against its row
  numbers; a histogram bins every
  numeric column, in 20 bins), a temporal x axis written in q's notation,
  colours from the editor's theme - from the same rows: the first or the
  last `q-lint.notebook.rowLimit`.
  `/ @title <text>` puts a title above it and `/ @height <px>` makes it
  that many pixels tall (100 to 2000; 300 otherwise).

**Set Notebook Row Limit**, on the notebook's toolbar, picks the row limit
- 10, 100, 1,000, 10,000, 100,000 or all - and whether it takes the first
rows or the last, and sets the two settings. The process cuts the table, so
only the rows shown are sent. The limit is a setting, not a property of the
notebook: a `.qnb` file carries no row limit of its own, so it shows the
same for everyone who opens it with the same settings, and a workspace's
settings can set one for its notebooks.

They are q comments, so a cell runs the same as a query or in a script. A
directive q-lint does not know, a chart of no known kind, or a title or
height on a cell with no `/ @chart`, fails the cell with the directives it
does know. An error shows q's message and, on kdb+
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

A chart's output is two items: an `application/vnd.q-lint.chart+json`
item, which q-lint's notebook renderer draws, and the table as `text/plain`,
which an editor without the renderer, or another tool reading the file,
shows instead. The JSON holds the chart's `kind`, its `title` and `height`
when given, a `note` when the table was cut, and the `grid` the result
panel gets: each column's `name`, `type` and whether it is a `key`,
`numeric` or `temporal`, its `cells` as q writes them, a numeric or temporal
column's `values` as numbers (a temporal in its own unit since
2000.01.01), and the table's `total` rows. The renderer loads Chart.js from
the extension's files, not the network, and redraws in the new colours when
the theme changes.

`qnb` is the format version; a newer one than this extension reads is
refused with that said. `source` is the cell's lines. A code cell is q
unless it has a `language`. Outputs are saved, so a notebook reopens with
its results: an item is `text` when it is UTF-8 and `base64` otherwise.
`execution` holds the run's number, outcome and start and end, in
milliseconds since the epoch. Fields with nothing in them are left out, a
field q-lint does not know - on the file or on a cell - is kept and saved
back, and saving a notebook that was opened unchanged writes the same file. A file
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
| `q-lint.query.mode` | `"console"` | Where a result goes: `console`, `grid` or `chart`. | `q-processes.cfg.queryMode` |
| `q-lint.query.gridLimit` | `10000` | The most rows the process sends to the grid or chart. | - |
| `q-lint.query.gridDecimals` | `-1` | Decimal places of a float or real in the grid and its CSV; `-1` as the process writes it (`\P`). | `q-processes.cfg.queryGridDecimals` (default 3) |
| `q-lint.query.resultsLocation` | `"editor"` | Where a grid or chart opens: `editor`, beside it, or `panel`, the **q Results** view in the bottom panel. | - |
| `q-lint.query.unwrapped` | `false` | Send code as plain strings, for a gateway that refuses a lambda, and format the result in q-lint. **Toggle Unwrapped Query** changes it. | - |
| `q-lint.query.timeout` | `0` | Seconds a query may run before it is aborted, as Abort does; `0` none. | - |
| `q-lint.processExplorer.excludedNamespaces` | `["q","Q","h","j","o","s"]` | Namespaces the Process Explorer and live completion leave out, with those nested in them. | - |
| `q-lint.processExplorer.previewLimit` | `5` | Rows of a table Preview shows. | - |
| `q-lint.processExplorer.autoRefresh` | `false` | Read the process again after each query. | - |

### Terminal settings

Read when a q terminal starts, so a change applies to the next one. None
reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.terminal.qBinary` | `"q"` | The q binary a terminal starts: a name on `PATH` or a path. It is quoted for the terminal's shell (POSIX, PowerShell or cmd), so it names one program, not a command with arguments. | `q-terminal.cfg.qBinary` |
| `q-lint.terminal.envPath` | `""` | A file of `NAME=value` lines set for q, such as `QHOME` and `QLIC`. They go on the command line that starts q (`NAME=value q`, `$env:NAME=` in PowerShell, `set` in cmd), so they win over what your shell's startup files set, and show there. Relative to the workspace folder. It is read, not run as a shell script as q-pro's is: `#` lines are comments, `export ` is allowed, quotes around a value are dropped, and nothing is expanded: `$HOME` stays `$HOME`. | `q-terminal.cfg.envPath` |

### Discovery settings

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.discovery.refreshInterval` | `30` | Minutes between fetches of every discovery server, at most 1440. `0` fetches a server only on **Reload Discovery Server**, and when it is added or edited. | - |

### Notebook settings

Read when a cell runs. None reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.notebook.rowLimit` | `1000` | The most rows of a table a `@grid` or `@chart` cell is sent; `0`: every row. | - |
| `q-lint.notebook.rowLimitFrom` | `"first"` | Which rows of a larger table a cell shows: `first` or `last`. | - |

### Agent settings

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.agent.queryTimeout` | `30` | Seconds a query run by an agent through **Run q Query** may take before it is aborted, as **Abort Current Query** aborts one. `0` sets no limit. | - |

### Process settings

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.processes.tagColors` | `{}` | A tag's colour in the Processes view, as a theme colour id: `{"eu": "charts.purple"}`. Over the built-in `prod`, `uat` and `dev` colours; a value that is not a colour id is ignored. Changing it recolours the view at once. | - |

### Not here, and why

`kuki` is not planned for now. q-pro's `sourceFiles.includeGlob` is not
mirrored either: the index reads every `.q` file `qlinter .` would - less
what the configuration's `exclude` skips - and
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
extension falls back to `qlinter` on `PATH`. The q grammar is generated:
`python3 scripts/q_grammar.py > editors/vscode/syntaxes/q.tmLanguage.json`.
The `k`, `quke` (qcumber) and `q-console` (the query output) grammars beside
it are written by hand; `test/languages.test.js` pins what they colour.
