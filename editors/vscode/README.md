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
- **Idiom snippets**, in the completion list: the joins (`aj`, `aj0`, `wj`
  and `wj1` with their window, `lj`, `ij`, `uj`), a bucketed `xbar` select,
  the `.z` handlers (`zpg`, `zps`, `zpo`, `zpc`, `zpw`, `zts` with its `\t`,
  `zws`, `zexit`) and a TorQ process skeleton (`torq`: its namespace, a
  setting, `init` calling `.servers.startup` and starting a `.timer.repeat`,
  and the tick it runs). Each is q that parses, and the joins run as
  inserted over tables of the names they default to. They come from a
  completion provider rather than a contributed snippet file, so
  `q-lint.idiomSnippets.enable` can take them out of the list.
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
  Definition on the path in `\l path/file.q` opens that file - and the path
  is a link too, Ctrl/Cmd+click to open it, in `\l`, `system "l ..."` and a
  file symbol `` `:lib/x.q `` alike (`q-lint.documentLinks.enable`). A path
  that reaches no file, or a directory, is no link. What only
  running the code would tell - a name built at run time, `value "..."`,
  another process - is not found.
- **Rename Symbol** (F2) for a lambda's parameters and locals, and for a
  global across the workspace: every place Find All References lists, under
  the `\d` context each file is in, is rewritten - `add` under `\d .lib` and
  `.lib.add` elsewhere both become `plus`. Only the last part of a name is
  renamed (type `plus` or `.lib.plus`, not a name in another namespace).
  It is refused, with the reason, for a name q reserves or one in a
  one-letter namespace (`.z.pg`, `.q.f`), a name no workspace file assigns,
  a new name that is not one q takes, is already assigned, or is a
  parameter or local of a lambda that reads the global bare. A name reached
  through a string (`value "f[]"`), a bare symbol (`` `f ``) or another
  process is not seen and keeps its old name: preview the rename
  (Shift+Enter) when that matters. `q-lint.rename.enable` turns renaming off
  and leaves the rest of navigation on.
- **Generate qDoc**, a refactoring in the lightbulb and **Refactor...**
  menu inside a top-level function: it writes `/ @param` for each
  parameter - the signature's, or the `x`, `y` and `z` the body reads - and
  `/ @return` directly above the definition, below any description already
  there, for the descriptions to be typed after. Not offered when the
  comment above has an `@param` or `@return` already
  (`q-lint.generateQdoc.enable`).
- **Extract Function**, in the lightbulb and **Refactor...** menu over a
  selection: the selection becomes a lambda defined directly above the
  top-level statement it is in, under the same `\d`, taking the parameters
  and locals of the lambda around it that it reads, and the selection a
  call to it - `b*2` in `f:{[a;b] a+b*2}` becomes `extracted:{[b] b*2}` and
  `f:{[a;b] a+extracted[b]}`. Only a selection q reads as one value is
  rewritten: a whole term anywhere, or everything to the end of its
  expression (q reads right to left, so `y*z` of `x+y*z` is one and `x+y`
  is not). One that assigns, returns, names `.z.s`, sits in a qSQL phrase
  or cuts a name, string or list is refused, and **Refactor...** says why.
  `q-lint.extractFunction.enable` turns it off.
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
- **Inlay hints** for parameter names: in `rate[px;10 20]`, `qty:` is drawn
  before `10 20` when the workspace defines `rate:{[px;qty] ...}`, whether
  the call is qualified or bare under the `\d` in force. Only for a bracketed
  call to a function whose every definition declares the same signature -
  not `x`, `y` and `z`, which say nothing, nor two definitions that
  disagree. Not at an empty slot of a projection, past the last parameter,
  or where the argument is already the parameter's name.
  `q-lint.inlayHints.enable` turns them off, and VS Code's
  `editor.inlayHints.enabled` can show them only while a key is held.
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
  `{"processes": [{"label", "host", "port", "user"?, "tags"?, "tls"?}]}`,
  and any of `init`, `initFile`, `ssh`, `gateway` and `launch` (below).
  An import replaces processes of the same label, adds the rest, and says
  which entries it skipped. A process it moves to another host, port or
  user forgets its stored password, so that is never sent to the new one.
- **Set Connect Script**, on a process row: q code, or a q file, run on
  the process at every connect - the first, a reconnect after an abort, and
  an automatic reconnect - before any query is sent, as a query runs it
  (unwrapped when `q-lint.query.unwrapped` is on). Use it to load helpers,
  set `\d`, or open handles a session needs. A file chosen inside the
  workspace folder is kept relative to it, and is read again at each
  connect; a leading `~` is your home directory. A script that fails, or a
  file that cannot be read, is said in a warning and the output, and the
  connection is kept. On a process tagged `prod` it asks first. It is kept
  in the process list, and exported with it as `init` (code) or `initFile`;
  an import that brings a script new to a process asks whether to keep it,
  and a discovery server's list never brings one.
  `q-lint.connection.connectScript.enable` off runs no script and hides
  the command; the scripts stay in the list.
- **Set SSH Tunnel**, on a process row: a jump host the process is
  reached through, as you would type it for ssh (`bastion`, `me@bastion`,
  `me@bastion:2222`). Each connect starts the system `ssh` as
  `ssh -N -L 127.0.0.1:<free port>:<host>:<port> -- <jump host>` and
  connects to that local port; the host and port are the process's as the
  jump host sees them. ssh runs in batch mode, so it never asks for a
  password or a passphrase: it uses your agent and `~/.ssh/config`
  (`ProxyJump`, `IdentityFile`, a host alias), and q-lint keeps nothing.
  When ssh cannot open the tunnel, the error says what ssh said. The tunnel
  closes when the connection does, and the connection when ssh exits. It is
  kept in the process list and exported as `ssh`; a discovery server's list
  never brings one. `q-lint.connection.sshTunnel.enable` off hides the
  command, closes a connection through a tunnel, and refuses to connect to
  such a process rather than trying its host directly.
- **Set Gateway Server Types**, on a process row: marks the process as a
  TorQ gateway, with the server types its queries go to (`rdb hdb`); empty
  unmarks it. See **TorQ gateways** below.
- **Start Process** and **Stop Process**, on a process row, and **Set
  Launch Definition**: start a q or TorQ process on this machine from its
  launch definition - a program (empty: `q-lint.terminal.qBinary`), a script
  and arguments, asked for in turn - run as
  `<program> <script> -p <port> <arguments>` in the workspace folder, with
  `-p` left out when the arguments set it. Its output goes to an output
  channel of its own, `q: <label>`, which shows the command line first and
  how it ended last; the row says `running` while it is. Only a process
  whose host is this machine is started, never one whose port something
  already listens on, and **Stop Process** stops only what was started from
  here: SIGTERM, then SIGKILL after 3 seconds. Everything started is stopped
  when VS Code closes. In a process file a definition is `launch`, with
  `cwd` and `env` too; a TorQ process, for instance:
  `{"launch": {"script": "torq.q", "args": ["-proctype", "rdb", "-procname",
  "rdb1", "-load", "code/processes/rdb.q"], "cwd": "~/torq", "env":
  {"KDBCODE": "code", "KDBCONFIG": "config"}}}`. A discovery server's list
  never brings one. `q-lint.processes.launcher.enable` off hides the three
  commands and stops what was started.
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
- **Download Processes**: save a server's processes to the list, with the
  password given when connecting to any of them. One whose label a saved
  process has is skipped and named, never replaced.
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
that fails to connect is forgotten, and asked for again on the next, and
so are those of a server's processes when it is deleted or its URL or label
changed.

**The shared process list.** A `.qlint/processes.json` in the workspace
folder - the same JSON as an import, committed with the code - lists a
team's processes for everyone who opens the repository. Its processes are
shown in a **Workspace: .qlint/processes.json** group after the saved ones,
read again whenever the file is created, changed or deleted, and connect
as a discovered process does: once connected one is `.qlint/label`, and one
with a `user` asks for its password on the first connect and keeps it in
secret storage, forgetting it when the file moves the process to another
host, port or user. The file never holds a secret: a `password`, `secret`,
`token` or similar field is ignored, a warning names the processes that
held one, and a note under the group says so. Its connect scripts, SSH jump
hosts and launch definitions are read only in a trusted workspace; in a
restricted one they are left out and a note says so. A file that is not
JSON shows why under the group. **Add to Shared Process List**, on a saved
process row, writes the process there (creating the file), replacing an
entry of its label: its address, user, tags and settings, never its
password. `q-lint.processes.shared.enable` off stops reading the file,
removes the group, closes a connection to one of its processes, and hides
the command.

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

- **Run** and **Run test**, code lenses: **Run** above each function a
  statement at column 0 defines sends that statement, continuation lines
  and all; **Run test**, above a function named `test_*` (or qUnit's
  `testName`), sends it and then calls it with no argument. A definition
  under `\d .ns` is sent between `\d .ns` and `\d .`, so its body reads
  names as it does in the file, and a test there is called by its full
  name, `.ns.test_x[]` - which leaves the process at the root context
  afterwards. Either goes to the process the file is bound to, as the
  commands above do, and lands in the history. `q-lint.codeLens.enable`
  turns them off.

**Testing view.** The tests a **Run test** lens is drawn over - a
`test_*` or qUnit `testName` function a statement at column 0 defines,
`.qt.*` suites included - are listed in VS Code's Testing view, by file,
from the language server's reading of the workspace; so are k4unit suites,
CSV files with k4unit's `action,ms,bytes,lang,code,...` header, one test
per `true`, `fail` or `run` row. The list follows saves and files created
or deleted, and the view's refresh reads it again. **Run** runs the chosen
tests on the active connection, or asks which process to connect to when
there is none; **Run on q Process...** (the run button's menu) always asks.
A process tagged `prod`, `prd` or `production` is confirmed first. A
function test runs as its lens does - its definition under its `\d`, then
the call - and passes when nothing signals and it does not answer false
(`0b`, or a boolean list with a `0b`); the rest of its file is not loaded
first, so load what it needs (**Execute Entire File**) before. A k4unit
`true` row passes on `1b`, a `fail` row on an error, a `run` row on
anything but one; the file's `before` rows run once before its first test
and its `after` rows once after its last, and `k` rows go through `k)`.
The process's `\d` is put back after each test. A failure shows q's error
or the value at the test. `q-lint.testExplorer.enable` turns the
integration off: the tests leave the view and nothing is read or sent.

The code is cut into statements by q's own script rules: a line starting
with a space or tab continues the one above, `/` lines and block comments
are skipped, as is a first line starting `#!`, and a `\` line is a system
command. A closing `}` at column 0
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

**TorQ gateways.** A query from the editor to a process marked as a TorQ
gateway goes as `.gw.syncexec[query;servertypes]`, so the gateway runs it on
a server of each type and joins what they answer. The server types are, in
order: those **Query Gateway on Server Types...** (editor menu and palette)
asks for, for the selection or the current line; those a line at column 0
of the file names, `/ @servertypes hdb`; else the process's own. One
statement goes as a string, `.gw.syncexec["select from trade";\`rdb\`hdb]`;
several go as `({last value each x};("s1";"s2"))`, which each server runs in
order, answering with the last value, since q's `value` of one string takes
neither a newline nor a trailing comment as the end of a statement. The
history keeps the call as it was sent, and running it again does not wrap
it twice. A query from a notebook, the Process Explorer or an agent goes to
the gateway as written. `q-lint.connection.torqGateway.enable` off sends
every query as written and hides both commands.

**Streaming a tickerplant table.** With `q-lint.tickerplant.stream.enable`
on (it is off by default: a subscriber is a load on a tickerplant, which
sends it every update), **Stream Tickerplant Table**, on a process row or
from the palette, opens a connection of its own to the process, lists the
tables `.u.t` names, and subscribes to the one you pick with
`.u.sub[table;\`]`, as a TorQ or kdb+tick subscriber does. Each update the
tickerplant sends, `(\`upd;table;data)`, is shown in a grid beside the
editor, newest first, keeping the last `q-lint.tickerplant.stream.rows`
(1000; at most 10,000). The grid counts the rows received, redraws at most
five times a second, and **Pause** stops redrawing while the rows keep
coming. Closing it closes the connection, which the tickerplant drops as a
subscriber; it says so when the process closes it instead. On a process
tagged `prod` it asks first. The lambda that subscribes defines nothing on
the process. Turning the setting off hides the command and closes every
stream.

**Abort Current Query** stops waiting at once. q has no message that cancels
a query, so the connection is closed and opened again; the process goes on
running the query, and the new connection is made once it is free, however
long that takes. **Disconnect**, or connecting to another process, stops
it waiting.

**Query a Tag**, on a tag row in Processes, in a q editor's context menu or
from the palette, runs one query on every saved and discovered process
carrying a tag (ignoring case; asked for when none is given), and shows the
answers as one table in the result panel - as a grid even in console mode -
with a `process` column first. The code is the selection, or the statement
at the cursor, placeholders filled in; it also takes a tag as the
argument of a keybinding. Each process is queried over a connection of
its own, eight at a time, opened for the query and closed after, so the
active connection is left as it was; its connect script runs first, and
the query controls apply (unlimited, unwrapped, the timeout). A
notification shows the progress, and cancelling it stops waiting. Tables
are kept as they came under the union of their columns, a column one lacks
left empty; a value that is not tabular is one row, its text in a `result`
column; a q error, or a process that could not be reached, one row, its
message in an `error` column. Each table is cut at `q-lint.query.gridLimit`
rows, as a grid query is. Every run lands in Query History under its
process. `q-lint.query.tagQuery.enable` off hides and refuses it.

**Compare Query Across Two Processes**, in a q editor's context menu or
from the palette, runs the selection, or the statement at the cursor, on
two processes you pick - the second pick says which the first was - each
over a connection of its own as **Query a Tag** does, and opens a panel
beside the editor showing the answers side by side: the first process's
columns, then the second's, each pair of rows on one line. Two tables are
lined up as **Compare with Previous Run** lines up two runs: by their key
when both are keyed by the same columns, otherwise by their place.
Columns are matched by name (one only a side has is struck through on the
other), and cells by the text the grid shows, so floats compare to
`q-lint.query.gridDecimals`. A cell that differs is marked, a row only one
side has is marked on that side and hatched on the other, and a line above
says how many cells differ, how many rows only each side has, or that the
answers are the same. Anything that is not two tables - an atom, a list, a
q error, a process not reached - is shown as the two texts side by side.
The first 5000 rows lined up are drawn; the counts are of all of them.
Both runs land in Query History. `q-lint.query.compare.enable` off hides
and refuses it.

**Watch Query** is off by default, as it sends code on its own: turn on
`q-lint.query.watch.enable`. In a q editor's context menu or from the
palette, it runs the selection, or the statement at the cursor, on the
active connection now (connecting first if there is none), and again every
few seconds - `q-lint.query.watch.interval` (5) is offered, 1 to 86400 - as
a query from the editor runs. A grid or chart is refreshed in place, under
the same tab, keeping its view, sort, filters and scroll, and **Compare
with Previous Run** compares it with the run before; in console mode each
run clears the output first. The status bar shows `watching rdb every 5s
(12)`; clicking it, or **Stop Watching Query**, stops it, and so do a
disconnect, a dropped connection, a connect elsewhere and turning the
setting off. A run due while a query is out is skipped. Only the first run
lands in Query History. On a process tagged `prod` (or carrying a tag the
read-only guard guards) it asks before it starts, and code that would
change a guarded process is asked about once, then. It also takes the code
and the seconds as arguments.

**Read-only guard.** Code sent to a process tagged `prod`, `prd` or
`production` (`q-lint.processes.readOnlyGuard.tags`, ignoring case) is read
first, and when it would change the process, a modal asks before anything
is sent; Escape sends nothing. A change is: assigning a global (`a:1`,
`a+:1`, `t[0]:5`, `a::b` - and, inside a lambda, `a::` or a dotted
`.ns.v:`, as q makes those global; a column named in `select a:x from t` or
`([] a:1 2)` is not one), `update` or `delete` from a table named by a
symbol (`` from `t ``), `set`, `upsert`, `insert`, `hdel`, `exit`, `system`,
`.Q.dpft`, `.Q.dpfts`, `.Q.hdpf`, `.Q.en`, `0:` or `1:` to a file handle,
`2:`, an amend in place (`` @[`t;i;:;v] ``), `value` or `eval` of a string,
and a system command other than one that reads a setting (`\c`, `\d`, `\P`
alone) - `\t` and `\ts` are read for their expression. It holds for every
path that sends code: a query (line, selection, block, file, a Run lens, a
rerun, Preview, a saved query, a watched one, asked once when it starts),
**Query a Tag** and **Compare Query** (asked once, for every guarded
process they reach), a notebook cell and **Run Notebook with Parameters**,
**Redefine on Process** and hot reload on save (whose confirmation says so,
since they always assign; hot reload asks at every save, with no
**Reload on Every Save**) and a connect script, asked at each connect, and skipped, with the
connection kept, when declined; also a result-grid drill-down query, a run
from the Testing view (each test's definition), and a query to a TorQ
gateway, read as written - and a `.gw.syncexec` or `.gw.asyncexec` call,
such as one rerun from the history, is read inside its strings. A guarded
process holds no result for paging, since holding assigns `.qlint.held`,
and streaming its table asks first, since `.u.sub` adds a subscriber. An agent's query cannot be asked about, so
one that would change such a process is refused with why, and never offered
to you. q-lint's own reads - the Process Explorer, Monitor, HDB browser,
hovers and the heartbeat - define nothing and are not asked about. The
guard reads the code's text: a function defined earlier that writes, or a
string built at run time and evaluated, is not seen, so it guards against a
slip, not a person - a process that must not change needs its own `.z.pg`.
`q-lint.processes.readOnlyGuard.enable` off sends code unasked, as before.

**Placeholders.** A query from the editor (line, selection, block or entire
file) that holds `{{name}}` asks for each name's value in an input box, then
sends the code with the values put in place, as written - so a symbol is
typed `` `AAPL `` and a date `2024.01.01`:

```q
select from trade where date={{day}}, sym={{sym}}
```

Each box starts from the value you gave that name last, remembered across
sessions; Escape runs nothing. The history keeps the code as it was sent,
values in place. A placeholder is a q name (`day`, `.ns.v`, `start_date`)
found outside strings and comments; `{{x}}`, `{{y}}` and `{{z}}` are q
lambdas and never asked for. A lambda that reads a global as `{{a}}` is
taken for one too: `q-lint.query.placeholders.enable` turns them off.

**A long query.** While a query runs, the status bar spins and counts its
time (`q: rdb 1m 05s`). When one that ran at least `q-lint.query.notifyAfter`
seconds (10 by default; `0` never) ends while the VS Code window is not
focused, a notification says so: finished, failed with q's error, or timed
out. One you aborted is not announced. `q-lint.query.progress.enable` off
turns both off: the status bar only spins.

**Connection health.** Both are off by default, as each acts without being
asked. With `q-lint.connection.heartbeat.enable` on, q-lint sends `::` as a
plain string on the active connection every
`q-lint.connection.heartbeatInterval` seconds (30 by default), and the status
bar shows its round trip: `q: rdb 3 ms`. It defines nothing on the process,
and a q error back (a gateway that refuses the string) still counts as an
answer. It is skipped while a query or the Process Explorer's read is out,
and a query sent while one is out waits for it; one unanswered for 5 seconds
shows as `no answer 12s` - the process is busy, or gone. A process that logs
its clients sees every heartbeat. With
`q-lint.connection.autoReconnect.enable` on, a connection the process or the
network drops is reconnected: the status bar shows `reconnecting to rdb (2
of 5)`, the tries wait 1, 2, 4... seconds (at most 30) up to
`q-lint.connection.reconnectAttempts`, failures are quiet until the last,
and the connect script runs again. **Disconnect**, connecting elsewhere or
turning the setting off stops it; a connection you closed, or one aborted,
is never reconnected this way.

**Query History** lists each query with its process, time, duration and
outcome; the buttons on a row run it again on the active connection and
**Copy Query** copies its code, and **Clear Query History** empties it.

**Filter Query History**, on the view's title bar, narrows it by process,
outcome (succeeded; failed, which is any of error, timed out and aborted; or
each of those) and text found in the code or q's error, ignoring case. It
asks for each in turn, starting from the current filter, and takes
`{"process", "outcome", "text"}` as an argument for a keybinding. The view's
title says what it is filtered by, and **Clear Query History Filter**, in
place of the filter button, shows every query again. The filter lasts for
the window. **Export Query History** writes the queries the view shows
(through the filter, if one is set) to a file: a `.q` file as a q script,
oldest first, each query after a `/` comment naming its process, time,
duration, outcome and error; any other name as JSON,
`{"queries": [{"process", "at", "millis", "outcome", "error"?, "code"}]}`,
newest first. `q-lint.queryHistory.search.enable` off hides the filter and
export, and clears a filter set.

**Saved Queries**, a view in the q-lint panel, keeps named queries for the
workspace. **Save Query** - on the view's title bar, in a q editor's
context menu, or on a Query History entry - saves the selection, or the
statement at the cursor, or that entry's code, as written, under a name you
give (the first line is offered); placeholders stay in it and are asked for
each time it runs. On a saved query's row: **Run Saved Query** runs it on
the active connection as a query from the editor runs (connecting first if
there is none; the read-only guard applies, and it lands in Query History),
**Edit Saved Query** - also a click on the row - opens it as a q document of
its own (`q-lint-saved:/name.q`), linted as any q file, where saving saves
the query, and **Rename** and **Delete Saved Query**, which asks first.
Each takes a query's name as an argument for a keybinding. The list is kept
in the workspace's storage, not in a file, so each workspace has its own and
nothing is written into the folder. `q-lint.savedQueries.enable` off removes
the view and its documents and makes the commands refuse; the queries are
kept for when it is on again.

**Query controls.**
- **Toggle Unlimited Query**: while on, the console text is not cut at
  `q-lint.output.consoleSize`, and a grid or chart is sent every row, not
  `q-lint.query.gridLimit`. The status bar shows `unlimited`, and clicking
  it turns it off. It stays on until turned off, as q-pro's does, but only
  for the window: a reload turns it off, so a result sent whole is never
  left over from an earlier session. One cut q makes itself remains: KDB-X
  writes an atom or a list item with `-3!`, which stops at the process's own
  `\c` width, so a simple list (`til 100000`) or an enumerated one
  (`exec sym from trade` on an HDB) is sent as its values and written out
  by q-lint instead, and a general list's long items are still cut at `\c`.
- **Toggle Unwrapped Query**, or `q-lint.query.unwrapped`: for a gateway
  that refuses a lambda, the code is sent as plain strings, one per
  statement in order, stopping at the first error, as a client that sends
  strings sends them; q-lint runs nothing of its own there. The process
  evaluates each as it evaluates any string (its `.z.pg`), so a `\d` lasts
  only for its own statement. The answer is whatever the process returns,
  formatted by q-lint: tables, keyed tables, dictionaries, lists and atoms
  as q's console writes them, and a table, dictionary or list reaches the
  grid and chart too. A lambda is shown as its text; any other function
  (a primitive, a projection, a composition) is only said to be one, and a
  float is written at q's default `\P` of 7 digits, since q-lint asks the
  process nothing of its own. Errors still come back as q errors, without
  a trace. The status bar shows `unwrapped`.
- **Query timeout**, `q-lint.query.timeout` seconds (`0`, the default, is
  none): a query still running then is aborted exactly as **Abort Current
  Query** aborts it, and the history records it as timed out.
- **Choose Connection for File** binds the active file to a process, kept
  per workspace and kept when the file is renamed or moved (an untitled
  editor's only until it or the window closes, so the next `Untitled-1` is
  not bound to it), and takes a label as an
  argument for a keybinding. A query from that file (line, selection, block or entire file) switches the
  connection to its process first, connecting if nothing is connected -
  there is one connection at a time, so the file's process becomes the
  active one, and an unbound file then queries it too. The history, a
  rerun, Preview and notebooks use the active connection, never a binding.
  While the file's process is not the active connection, the status bar
  shows `file: <label>`. **Clear Connection for File** removes the binding.
  Renaming the process (**Edit Process**) carries its files along, and
  deleting it removes their bindings.
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
  key columns and a `value` column) or a list (as one `value` column) opens in the **q-lint: result** panel. Click a header (or Tab to it and press Enter) to sort,
  type under it to filter (by the text shown, ignoring case). **Copy as
  CSV** copies the rows shown, in the order shown, and **Export to CSV**
  saves them to a file you pick; the command **Export Results to CSV** does
  the same, and takes the file's `Uri` as an argument to skip the dialog.
  In the CSV, a cell or name a spreadsheet would run as a formula (`=`,
  `+`, `-` or `@` first, but not a number) starts with `'`: a symbol or a
  string, and a `-0W` or a negative timespan too.
  Each cell is what q
  prints in a table: a timestamp keeps its nanoseconds, a long above 2^53
  every digit, a null is blank and an infinity is `0W` or `0w`. Sorting is
  q's own order (`iasc` on the process), nulls first, and either way keeps
  equal values in their order, as `xasc` and `xdesc` do.
- **Chart**: the same results as a line, bar, scatter or histogram chart of
  the numeric columns against the first (a list against its row numbers),
  chosen in the panel; the panel's
  **Grid** and **Chart** buttons switch between the two for one result.

The panel has two more views of the same rows. **Stats** (or **Show Column
Statistics**) gives each column's count, nulls, distinct values, min, max
and mean, over the rows shown, so the grid's filters apply: min and max in
q's own order, nulls left out, and the mean of a numeric column without its
nulls or infinities. **Tree** (or **Show Result as Tree**), for a dictionary
or a general list, shows the value as a tree that opens a level at a time:
a dictionary's entries, a list's items, and a simple list's atoms. The
process sends at most 2,000 nodes of it, shared out level by level, and a
node says how many of its items were not sent.

**Heatmap** in the grid (or **Toggle Result Heatmap**, which sets
`q-lint.query.gridHeatmap`) colours the numeric columns by value in the
theme's chart colours: blue from the least to the greatest, or, for a column
either side of zero, blue above it and red below, stronger further out. A
key column is left as it is.

The panel keeps the last `q-lint.query.resultHistory` results (10) as tabs
above it; choosing one shows it again with its own view, sort and filters,
and **Show Result from History** picks one from a list. When a query has run
before in this window, **Compare** (or **Compare Result with Previous Run**)
marks what changed since: a changed cell is shaded and underlined, its
tooltip says what it was, a new row or column is shaded, and the rows that
went are listed under the grid. Rows are matched by their key when both
results are keyed by the same columns, and by their place otherwise; cells
are compared by the text the grid shows, so `q-lint.query.gridDecimals`
applies. The previous run can be on another process, which the bar names.

**Export as...** in the bar (or **Export Results As...**) saves the rows
shown, in the order shown, as Excel (`.xlsx`), Parquet, JSON, a Markdown
table or q; **Copy Results As...** puts JSON, Markdown or q on the
clipboard. Both take the format (`xlsx`, `parquet`, `json`, `markdown`,
`q`) as an argument, and Export the file's `Uri` too. Markdown shows the
cells as the grid does. The others write what the process sent rather than
what the grid shows: a float's every digit, a long past 2^53 exactly, a null
as a null.
- **Excel**: one sheet, its header bold and frozen. Numbers and booleans are
  Excel's own, and so are temporals: a date, month, timestamp or datetime
  as a date, a timespan, minute, second or time as a duration, so a sheet
  computes with them. What Excel cannot show - a date before 1900-03-01, a
  negative duration, an infinity, a long it would round - is q's text. Cut
  at Excel's 1,048,576 rows, and the message says so.
- **Parquet**: one row group of typed columns - booleans, 8- to 64-bit
  integers, floats, dates, timestamps (to the nanosecond, not adjusted to
  UTC) - with q's nulls as Parquet's. A symbol, guid, char, month,
  timespan, minute, second, time or general list is a string, as q writes
  it. An infinite date or timestamp, which Parquet's types cannot hold, is
  a null, and the message counts them.
- **JSON**: an array of row objects; a number (a byte too) is a number, a
  boolean a boolean, a null `null`, and the rest - temporals, symbols, an
  infinity, which JSON has no number for - q's text.
- **q**: an expression that rebuilds the table, keyed as it was:
  `([sym:`a`b] px:(1.5f;0n))`, or `flip` of a dictionary when a column's
  name is one q reserves (`count`, a dictionary's `key` and `value`). A
  dictionary or a list is written as the table the grid shows; an
  enumeration as its symbols; a cell cut at 200 characters is not its
  whole value, and the message says how many were.

Both files are written by q-lint itself, with no library: the xlsx is a zip
of the XML parts Excel needs, the Parquet file one uncompressed page per
column with its footer in Thrift's compact protocol. The extension's tests
read them back with openpyxl, pyarrow and DuckDB when `QLINT_TEST_READBACK`
names a Python that has them.

**Pivot** (or **Show Result as Pivot**) turns the rows shown into a table:
one row per value of one column, one column per value of another (or none),
and in each cell the count, sum, average, min or max of a third, chosen
above it. Values are in q's order, as the grid sorts them; a count counts
the non-null values (or the rows), and the others a numeric column's values
without its nulls and infinities. At most 100 column values are shown, and
**Copy Pivot** copies it as CSV.

The chart also draws an **area**, a **step** line and **candles**: open,
high, low and close columns found by name (`open` or `o`, and so on, any
case), or else the first four it can plot, a candle green when it closed at
or above its open and red below. With two series or more, **right axis**
puts one on a second y axis. **Save PNG** and **Save SVG** (or **Save
Result Chart as Image**, which takes `png` or `svg` and a `Uri`) save the
chart: the PNG as drawn, on the editor's background, and the SVG as vector
graphics drawn by q-lint from the same data, for a document or a slide.

**Drill down.** `q-lint.results.drilldownTemplates` holds follow-up queries a
grid cell offers: double-click a cell, or right-click it and choose **Drill
Down from Cell**, pick one, and it runs on the process the result came
from, as a query from the editor would, its result shown as any other. In a
template's `query`, `{{value}}` is the cell's value as q - `` `AAPL ``,
`2024.01.02`, `0Nj` - `{{column}}` its column's name as a symbol, and
`{{row.name}}` the value of column `name` in the same row; `columns` limits
it to some columns.

```json
"q-lint.results.drilldownTemplates": [
  { "label": "Trades", "query": "select from trade where date={{row.date}}, sym={{value}}", "columns": ["sym"] }
]
```

The pick shows each query as it will run. A production process (tagged
`prod`) asks first.

**Paging**, off by default (`q-lint.results.paging.enable`): a result cut at
`q-lint.query.gridLimit` stays on the process, as `.qlint.held`, and the
grid asks it for the next `gridLimit` rows as it scrolls to the end (or on
**Load more**, or **Load More Result Rows**), up to 1,000,000. Sorting,
filters, Stats and the pivot apply to the rows fetched so far; the rows are
ranked again over all of them, so a sort is still q's order. The process
holds one result, replaced by the next grid query while paging is on
(emptied when that one is not cut). Nothing is held on a production process
or in unwrapped mode. Turning paging off stops holding new results; one
already held stays until the process restarts or `.qlint.held:()` frees it.

Each of these - the history, Compare, Stats, the heatmap, the tree, export,
paging, the pivot, the new charts and drill-down - has its own
`q-lint.results.<feature>.enable` setting, on by default but for paging.
Turned off, its button and command are gone (the command, run anyway, says
which setting turns it back on), and a change applies at once, without a
reload.

The panel opens beside the editor. With `q-lint.query.resultsLocation` set
to `panel`, results go instead to the **q Results** view in the bottom
panel, beside the terminal and the output, and the editor keeps the focus.
It is the same page as the editor's - the same grid, chart and buttons -
and keeps its view, sort, filters and scroll when the panel is hidden and
shown again, as the editor's page does when its tab is.

The process sends at most `q-lint.query.gridLimit` rows, and the panel says
when a result was cut and how many rows it had. Anything that is not
tabular - an atom, a string, a function - and every error still goes to the
output. As in console mode, nothing is defined on the process: the rows are
shaped by the lambda sent with the query. Paging, when it is on, is the one
exception: it holds the result as `.qlint.held`. The panel loads only the
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
with thousands of names it reads 100 namespaces at most, the first 500
names of each in sorted order, and a table's first 500 columns, and says how
many it left out. **Preview**,
on a table or a variable, runs its first `q-lint.processExplorer.previewLimit`
rows, or the variable, as a query. The explorer shares the query connection:
while a query runs it waits and refreshes after, and a query sent while it
reads waits for it.

**Table details.** Hovering a table in the Process Explorer shows its
columns with their types, attributes (`s`orted, `u`nique, `p`arted,
`g`rouped) and foreign keys, from `meta`, its rows, and for a table in
memory the bytes it takes (`-22!`). A partitioned table is counted by
`.Q.cn` and its `meta` read from the last partition; neither it nor a
splayed table is loaded or measured, and the hover says so. With
`q-lint.processExplorer.editorTableHover.enable` on (it is off by default,
since it asks the process whenever the mouse rests on a name), hovering a
table's name in a q editor shows the same, shorter, beside the language
server's hover. Details are read once per refresh of the explorer.

**Live values.** With `q-lint.liveValueHover.enable` on (off by default,
since it asks the process whenever the mouse rests on a global), hovering a
global in a q editor shows its value on the connected process beside the
language server's hover: its kind and count, then the value as the console
prints it - within `\c`'s rows and columns - cut at 2,000 characters. The
language server says which global the mouse is on, under the `\d` in force,
so a local or a word of q's asks nothing. The name is found by its
namespace's `key`, never by evaluating it; a view is named and not run, a
partitioned table is not printed, and a process tagged `prod`, `prd` or
`production` is not asked. The read waits up to a second for a query to
finish, and shows nothing if it does not.

**Undefined names.** With `q-lint.undefinedNames.enable` on (off by
default, since it asks the process on its own), a q file gets a warning on
each global it reads that neither the workspace nor the connected process
defines - a name defined only on the process, by a script outside the
workspace or by hand, is no longer a mystery. The language server lists the
names no workspace file defines (not q's words, nor a name in a one-letter
namespace such as `.z.pc`, nor a name in a qSQL phrase that may be a
column), and the process is asked which of them its namespaces hold, by
`key`, evaluating nothing. The active file is checked when it is opened,
saved or brought to the front, on connect and after each query, only while
the connection is free; a disconnect clears the warnings. A production
process is asked only by **q-lint: Check Undefined Names on Process**,
after a confirmation.

**Function source.** **Open Function Source**, on a function in the Process
Explorer or the name under the cursor in a q editor, shows the function as
the process has it (`last value f`) in a read-only editor, headed by the
namespace it was defined in; a projection or composition is shown as q
prints it. **Edit and Redefine**, in that editor's title bar, copies a
lambda into a new q editor, and **Redefine on Process** in its title bar
sends the edit back. It asks first, in a modal that warns when the process
is tagged `prod`, `prd` or `production`; it goes only to the process the
function came from, and is refused if the function there has changed since
it was opened. The new text is parsed in the namespace the function was
defined in, so its globals mean what they meant, and the process's own
`\d` is left as it was. Nothing is written to a file: a restart of the
process brings back the old definition.

**Drift detection.** **Check Drift Against Process**, in the Process
Explorer's title bar or the palette, compares the functions the workspace's
q files define with what the connected process holds. A definition is a
top-level `name:{...}`, in the context `\d .ns` gives it, as loading the
file would define it; texts are compared without trailing blanks. It reads
each name's `last value` from the process, and changes nothing there. The
list shows the functions that differ, are not defined on the process or
are not a lambda there; picking one that differs opens a diff of the
process's text and the file's, and picking another opens the file at its
definition. An open file is read as the editor has it. It reads up to 5000
files and 20,000 definitions. Off by default
(`q-lint.processExplorer.driftDetection.enable`), since it reads every
function the workspace defines from the process.

**Hot reload on save.** With `q-lint.hotReload.enable` on (it is off by
default), saving a q file sends the function definitions the save changed
to its process: the process the file is bound to by **Choose Connection
for File**, which must be the connected one, or the active connection when
it has no binding. It never connects. Each goes as **Redefine on Process**
sends an edit: after the same modal, with the same warning for a process
tagged `prod`, `prd` or `production`, parsed in the namespace the function
was defined in, and refused if the process no longer holds the text it was
read with. A function is replaced only while the process holds the text
the file had before the edit - when the file was opened, or last reloaded
- so a process that has drifted is never overwritten: such a function, a
new one, or one the process does not hold as a lambda is listed as not
sent. You are asked on every save that sends something, until you pick
**Reload on Every Save** for that file and process, which lasts until the
window closes or the setting is turned off; a production process is never
offered it.

**Find Callers in Process**, on a function in the explorer or the name
under the cursor, lists the loaded functions that call it, read from what q
parsed rather than from text: each lambda's globals, resolved in its
namespace (a lambda defined in `.ns` that calls `f` calls `.ns.f`), and
those of the lambdas nested in it. A local, a parameter, a string or a
comment that spells the name is not a call. A lambda whose text holds the
name as a symbol (`` value(`f;x) ``) is listed as naming it. Picking one
opens its source at the call. Namespaces in
`q-lint.processExplorer.excludedNamespaces` are not read.

**Process Monitor** shows the connected process's memory (`.Q.w[]`), its
open handles (`.z.W`) with the bytes queued on each and which is this
connection, its timer (`\t`, `.z.ts`, and TorQ's `.timer.timer` when there
is one), its `\` settings and its version, pid and host. It reads them in
one call when shown, on connect and on **Refresh Process Monitor**, and
every `q-lint.processMonitor.refreshInterval` seconds while shown, if set.
It never reads the command line (`.z.x`), which can hold a password.

**HDB Browser**, for a process that has loaded a partitioned database,
shows its partition field, root, segments (`par.txt`) and sym file size;
its partitions, newest first, with the rows of each table in each; and its
tables with their rows in all, splayed ones too. No data is read: the
partitions are `.Q.pv`, the rows `.Q.cn`, which reads each partition's count
from a column file and caches it in `.Q.pn` as the explorer does, and the
sym file's size `hcount`. The newest 1000 partitions are listed.

The Monitor, the HDB Browser, Open Function Source and Find Callers share
the query connection as the explorer does: they never interrupt a query,
and wait a moment for one to finish. Each of these features has its own
`enable` setting (below); turned off, its commands are hidden and refuse,
its view or hover is gone, and it sends nothing.

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
A name q cannot parse (`café`, `a b`, made with `set`) goes in as Preview
reads it, by its symbol: ``get`$"café"``.

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
  table; a table of more than 100 columns gives its first 100, with
  `columnCount` and `truncated: true`. Booleans and numbers are JSON values and nulls `null`; a
  temporal, a symbol, a guid or a nested value is q's text, and so are a
  long above 2^53 and an infinity, so a timestamp keeps its nanoseconds;
- any other value: `{output}`, the process's text of it at
  `q-lint.output.consoleSize`;
- a failure: `{error, trace?}`, the backtrace cut at 40 lines.

A query running longer than `q-lint.agent.queryTimeout` seconds, or one the
agent cancels, is aborted as **Abort Current Query** aborts one, and the
agent is told so. Each agent query goes into **Query History**, marked
`agent`. The tool needs VS Code 1.95 or later; before it, only the command
is there.

Two more tools read and lint without running anything. **List q Tables**
(`q-lint_listTables`, `#qTables`) answers the connected process's tables -
each by the name a query uses, with its kind, rows and first 50 columns -
or, given `{"table"}`, that table's schema from `meta`: each column's type,
attribute and foreign key, its keys and rows. It reads as the Process
Explorer reads, with the same lambdas and limits, and only the connected
process: to read another, an agent connects with Run q Query's `process`.
**Lint q Code** (`q-lint_lint`, `#qLint`) runs the qlinter the language
server runs on the code it is given, as the file `{"file"}` names (for its
configuration) or `snippet.q`, and answers its findings. Each has its own
setting, `q-lint.agent.schemaTool.enable` and `q-lint.agent.lintTool.enable`;
turned off, the tool is unregistered.

**@q in the chat.** `@q <code>`, or `@q` with q code selected in an editor,
explains the code, right to left. The model is the one picked in the chat,
through VS Code's language-model API: q-lint holds no key and calls no
service of its own. With the question go the language server's hovers on
the selection's names and its findings there, and what the connected
process holds for each name the code uses (a function's source, a table's
columns, a variable's type and first items), read without running the
code. `@q /error` explains the last failed query in Query History, with its
code, or the error typed after it. The model may call q-lint's tools: Run q
Query asks you first, as it always does. `q-lint.chat.participant.enable`
off removes `@q`.

**Draft qSQL from a Description**, in the palette or a q editor's context
menu, asks a language model for a query that does what you describe, given
the connected process's tables and columns, and opens the draft in a new q
editor. Nothing runs: the notification offers **Run**, which runs the
draft as it then stands, edited or not, as a query from an editor runs,
and **Insert at Cursor**, which puts it in the editor you started from.
Close it, and nothing happens. `q-lint.chat.englishToQsql.enable` off hides
the command. Both need a language model in VS Code, such as GitHub
Copilot's; without one they say so.

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

Two more directives say where a cell runs and what it is for:
- `/ @process <label>`: the cell runs on that process - a saved one, or a
  discovered one as `server/label` - connecting to it first as **Connect**
  does, with its password from VS Code's secret storage or asked for. The
  connection stays there, so the cells after it run there too, as they do
  after a file bound to a process switches it. Connecting to a process
  tagged `prod`, `prd` or `production` asks first; one a query is still
  running on is not left. A label that names no process fails the cell with
  the labels there are.
- `/ @parameters`: the cell holds the notebook's parameters, one
  `name:value` a line (papermill's convention). It runs as any cell does;
  **Run Notebook with Parameters** puts the values it is given in a cell
  right after it.

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
does know. A qDoc line (`/ @param`, `/ @return`, `/ @eg` and the rest) is
documentation, not a directive: it ends the directives, so a cell that
opens with a documented function runs. An error shows q's message and, on kdb+
3.5 and later, its backtrace.

### Live values in Markdown

`{{q: expr}}` in a Markdown cell shows the value of `expr` on the process:
``Total {{q: sum t`px}} over {{q: count t}} trades``. The values are read
when the code cell above the Markdown runs - for Markdown above every code
cell, when the first one runs - each on its own, so one that fails shows
its error and the rest still show. A string or a symbol shows as its
characters, anything else as `-3!` writes it, cut to 200 characters. They
run only when you run a cell, never on their own; nothing is defined on the
process but what an expression defines. The cell's source is not changed:
the values are kept in its metadata, saved with the notebook, and shown
escaped in place of their expressions. One not read yet shows as written,
and in a code span or a code block `{{q: ...}}` is text.
`q-lint.notebook.liveValues.enable` turns them off.

### Notebook Variables

The **Notebook Variables** view, in the q-lint sidebar while a q notebook
is the active editor, lists the globals in the root namespace of the
process the notebook's cells last ran on: each one's name, its type, its
count (a table's rows) and its size, the bytes `-22!` says it takes
serialized (none for a function or a partitioned table, which would read
every partition). It is read with one lambda that defines nothing, after a
cell runs and on **Refresh**, only while the view is open, and never in
front of a query. It lists what the cells defined and anything else defined
there; up to 1,000 names.

### Running a notebook with parameters

**Run Notebook with Parameters**, on the notebook's toolbar and a `.qnb`
file's context menu, runs the whole notebook without its editor: it asks
for each parameter of the `/ @parameters` cell, offering the notebook's
value, and writes the run - every cell's output, Markdown's live values -
to a new file: a `.qnb`, or an HTML page or a Jupyter notebook by the
name's extension. The given values go in a cell right after the parameters
cell, marked so a later run replaces it. Cells are numbered from 1; the run
stops at the first cell that fails and clears what the cells after it
showed, so nothing stale passes for this run's. Cells run on the active
connection, and `/ @process` cells as they do in the notebook.

The same run works from a shell, with Node.js, as the script the extension
ships in `out/qnbrun.js` (in an installed extension,
`~/.vscode/extensions/wojdalski.q-lint-<version>/out/qnbrun.js`):

```sh
node out/qnbrun.js report.qnb --process localhost:5001 \
  -p date 2024.01.02 -p syms '`EURUSD`GBPUSD' -o report-0102.html
```

A value is q text, so a string is `-p name '"text"'`. `--process` is
`host:port`, or a label in `--processes FILE`, a list as **Export Process
List** writes it, which also names the processes `/ @process` cells ask
for. A password is never an argument: it is read from `QLINT_Q_PASSWORD`,
or `QLINT_Q_PASSWORD_<LABEL>` for a listed process (its label in capitals,
anything but a letter or digit as `_`), with `--user` for `host:port`. A
listed process tagged `prod`, `prd` or `production` is refused unless
`--allow-production` is given. `--row-limit`, `--rows-from` and
`--console-size` stand in for the settings. It exits 0 when every cell ran,
1 when one failed (the file is written, run up to it), and 2 for a usage
error or a file it cannot read or write; `--help` says the rest. The script
does not read VS Code's settings.

### Export and import

**Export Notebook as HTML** writes one self-contained page: no script, its
style inline, a policy that fetches nothing, light and dark from the
system. Code, outputs and Markdown are escaped; Markdown is rendered
(headings, paragraphs, lists, quotes, code, emphasis, and links to http,
https and mailto only) with its live values. An output's `text/plain` view
is shown, never its `text/html`, which a notebook from elsewhere could fill
with script; a chart shows as its table; an image is kept.

**Export Notebook as Jupyter Notebook** writes nbformat 4.4, with q's
kernel spec: a q cell is a code cell, a cell in another language says so as
VS Code's Jupyter support does (`metadata.vscode.languageId`), outputs keep
their types, an error is Jupyter's error output.

**Import Jupyter Notebook as q Notebook**, on a `.ipynb` file's context
menu, writes it as a `.qnb` and opens it. A code cell is q when the cell or
the notebook says q - or says nothing - and keeps its language otherwise,
so a Python notebook's cells stay Python; a `%%q` cell (PyKX's magic) is q,
without the magic line. Markdown, outputs and run numbers are kept; a raw
cell is a code cell in `raw`.

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
field q-lint does not know - on the file, a cell, an output, an item or a run - is kept and saved
back, and saving a notebook that was opened unchanged writes the same file. A file
that is not a notebook does not open: the editor says what is wrong with
it, and the file is left as it was. An empty file is a new notebook.

## The local q

**q interpreter.** **Select q Interpreter**, or the status bar item beside
a q editor, lists the q binaries on this machine: KDB-X's `~/.kx/bin/q`,
`$QHOME/<platform>/q` (`~/q` when `QHOME` is unset), each `q` on `PATH`,
and a PeachQ-style `q` (or `peachq`) at a workspace folder's root or in its
`bin/`. One file reached twice - `~/.kx/bin` on `PATH`, a link - is listed
once. Opening the picker starts each once with `-q`, to print its version
and exit, so each shows as `q 4.1 2024.10.16`; one that does not answer
says so. **Enter a q binary's path...** takes any other. The one picked
becomes the workspace's `q-lint.terminal.qBinary`: what the q terminals,
**Start Process** and the q tasks start. A binary inside a kdb+ install
(`<home>/m64/q` beside `<home>/q.k`) is started with `QHOME=<home>`, and one
inside a KDB-X install (`<home>/bin/q` with `<home>/q/` and a licence) with
`QHOME=<home>/q` and `QLIC=<home>`, so a `QHOME` your shell sets for another
q does not reach it; `q-lint.terminal.envPath` and the `.env` file still
win. The item shows the version once the picker has asked for it, and the
binary's name before.

**Licence expiry.** When the picker or **Check q Licence Expiry** starts a
q, it also prints the expiry date of its licence: the second item of
`.z.l`, as [code.kx.com documents it](https://code.kx.com/q/ref/dotz/#zl).
The licence files themselves (`kc.lic`, `k4.lic`) are not in a published
format, so they are only located - in `QLIC`, `QHOME`, the KDB-X install or
`~/q` - to notice one replaced, and never read. The date is kept on this
machine with the binary's path and version, and nothing else: no banner
text, no licensee, and it is sent nowhere. From then on, at start and when
the binary changes, a licence within `q-lint.licence.warningDays` of its
date is warned of once a day, without starting q. A q whose `.z.l` is empty
(PeachQ, a 32-bit kdb+) reports no date, and nothing is guessed; a licence
file changed since the date was learnt is not warned of until it is checked
again.

**`.env` files.** The variables of the workspace folder's `.env`
(`q-lint.env.file`) go to every q the extension starts here: the q
terminals and **Start q REPL**, **Start Process**, and the q tasks. The
file is read as `q-lint.terminal.envPath` reads its file - `NAME=value`
lines, `#` comments, quotes dropped, nothing expanded - each time one of
them starts. Its values may be secrets, so they go in the environment and
never on a command line, and no message or log ever shows one: a line that
is not `NAME=value` is named by its number, and the variables by their
names. In a terminal, q is started by your shell, so a variable your
shell's startup files export wins over the `.env` file's; put that one in
`q-lint.terminal.envPath` instead, whose variables go on the command line.
A launched process gets the `.env` file's variables under its definition's
own `env`. A missing file is no file.

**q tasks.** **Terminal > Run Task > q** offers **run current file** and,
for each test runner script in the workspace (`run_tests.q`, `runtests.q`,
`run_all_tests.q`, `run_test.q`, `test_runner.q`, `testrunner.q`), a
**test** task in the Test group. A `tasks.json` task can name any script:

```json
{ "type": "q", "script": "tests/run.q", "args": ["-quiet"], "label": "q tests" }
```

Each runs `q-lint.terminal.qBinary` on the script in the workspace folder,
with the variables above and nothing on its input, so q exits when the
script ends: 0 when it loaded, 1 at its first error. The `$q` problem
matcher puts that error in Problems at its file and line - the innermost
frame, so the loaded file of a `\l` - as KDB-X prints it
(`'2026.11.21T19:31:44.874 type` then ``[2]  /w/e.q:3: c:a+`x``) and as
PeachQ does (`'type`). Add `"problemMatcher": "$q"` to a task of your own
that runs q to use it there.

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
| `q-lint.enable` | `true` | Run the language server. Off: no diagnostics, Quick Fixes, formatting, navigation or semantic colouring; the grammar's colouring, processes, queries and notebooks stay. | - |
| `q-lint.serverPath` | empty | Your own `qlinter` binary. Empty uses the bundled one, then `qlinter` on `PATH`; set, it always wins. A leading `~` is your home directory. | - (q-pro runs `qls` from `PATH`) |
| `q-lint.serverArgs` | `[]` | Extra `qlinter --lsp` arguments, after the ones the settings produce. They keep their command-line meaning, so `--extend-select` here can widen the repository's selection. | - |
| `q-lint.profile` | unset | `general`: only what q refuses. `style`: also likely mistakes. `styleq`: also published style guides. `uqf`: also one repository's conventions. Unset, a repository's `qlinter.toml` decides, and `style` applies without one. | - |
| `q-lint.configFile` | empty | One configuration file for every document instead of the nearest `qlinter.toml` (`--config`); relative to the first workspace folder, and a leading `~` is your home directory. | - |
| `q-lint.lint.select` | `[]` | Show only these rule codes or prefixes, among those the configuration turns on. Narrows, never widens. | - |
| `q-lint.lint.ignore` | `[]` | Hide these rule codes or prefixes. | - |
| `q-lint.lint.run` | `onType` | `onType` lints every change; `onSave` lints on open and save. | - |
| `q-lint.lint.severity` | `{}` | The severity shown, by code or prefix, longest wins: `{"QS": "hint"}`. Display only. | - |
| `q-lint.fixes.unsafe` | `true` | Offer the editor-only Quick Fixes (`--unsafe-fixes`) as well as those `--fix` applies. | - |
| `q-lint.format.enable` | `true` | Register **Format Document** (the safe fixes). | - |
| `q-lint.semanticTokens.enable` | `true` | Colour calls and parameter reads on top of the grammar. | - |
| `q-lint.navigation.enable` | `true` | Offer the outline, workspace symbols, definitions, references, highlights and rename. Off when another q extension already navigates. | - |
| `q-lint.rename.enable` | `true` | Offer **Rename Symbol** for a local, and for a global across the workspace. Needs `q-lint.navigation.enable`. | - |
| `q-lint.help.enable` | `true` | Show hovers and signature help, from the source and the built-in catalogue of q's words. | - |
| `q-lint.completion.enable` | `false` | Complete locals, workspace names and q's words. Off by default: an editor told a server completes stops offering the words already in the file. | - |
| `q-lint.callHierarchy.enable` | `true` | Offer the call hierarchy of a global function. | - |
| `q-lint.graph.enable` | `true` | Offer the **q Dependencies** view and **q-lint: List Affected Tests**. Off: the view is hidden and the server answers neither. | - |
| `q-lint.inlayHints.enable` | `true` | Show parameter names at the arguments of a call to a workspace function. | - |
| `q-lint.codeLens.enable` | `true` | Show **Run** above each top-level function definition and **Run test** above a `test_*` one. | - |
| `q-lint.documentLinks.enable` | `true` | Make each `\l`, `system "l ..."` and `` `:file.q `` path a link to the file it loads. | - |
| `q-lint.generateQdoc.enable` | `true` | Offer **Generate qDoc** above a top-level function. | - |
| `q-lint.extractFunction.enable` | `true` | Offer **Extract Function** over a selection q reads as one value. | - |
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
| `q-lint.query.resultHistory` | `10` | Results the result panel keeps as tabs, 1 to 50. | - |
| `q-lint.query.gridHeatmap` | `false` | Colour the grid's numeric columns by value. **Toggle Result Heatmap** changes it. | - |
| `q-lint.results.history.enable` | `true` | Keep results as tabs, and offer **Show Result from History**. Off, the panel keeps only the result on show. | - |
| `q-lint.results.diff.enable` | `true` | Offer **Compare** and **Compare Result with Previous Run**. Off, no previous run is kept. | - |
| `q-lint.results.statistics.enable` | `true` | Offer the **Stats** view and **Show Column Statistics**. | - |
| `q-lint.results.heatmap.enable` | `true` | Offer the **Heatmap** button and **Toggle Result Heatmap**. Off, nothing is coloured, whatever `q-lint.query.gridHeatmap` says. | - |
| `q-lint.results.tree.enable` | `true` | Offer the **Tree** view and **Show Result as Tree**. Off, the process is not asked for the tree. | - |
| `q-lint.results.export.enable` | `true` | Offer **Export as...**, **Export Results As...** and **Copy Results As...**: Excel, Parquet, JSON, Markdown and q. CSV is always offered. | - |
| `q-lint.results.paging.enable` | `false` | Hold a result cut at `gridLimit` on the process as `.qlint.held`, and fetch more of it as the grid scrolls. Never on a production process. | - |
| `q-lint.results.pivot.enable` | `true` | Offer the **Pivot** view and **Show Result as Pivot**. | - |
| `q-lint.results.charts.enable` | `true` | Offer area, step and candle charts, a right axis, **Save PNG**, **Save SVG** and **Save Result Chart as Image**. | - |
| `q-lint.results.drilldown.enable` | `true` | Offer a grid cell's drill-down queries, on a double-click or **Drill Down from Cell**. | - |
| `q-lint.results.drilldownTemplates` | `[]` | The drill-down queries: `label`, `query` with `{{value}}`, `{{column}}` and `{{row.name}}`, and the `columns` each is offered for. | - |
| `q-lint.query.progress.enable` | `true` | Count a running query's time in the status bar, and notify a long one's end. | - |
| `q-lint.query.notifyAfter` | `10` | Seconds a query must run for its end to be notified while the window is not focused; `0` never. | - |
| `q-lint.query.placeholders.enable` | `true` | Ask for a value for each `{{name}}` in the code a query sends, and put it in place. | - |
| `q-lint.query.tagQuery.enable` | `true` | **Query a Tag**: one query on every process with a tag, the answers as one table. | - |
| `q-lint.query.compare.enable` | `true` | **Compare Query Across Two Processes**: one query on two processes, the answers side by side, differences marked. | - |
| `q-lint.savedQueries.enable` | `true` | The **Saved Queries** view and its commands. Off, the view is removed and the commands refuse; the queries are kept. | - |
| `q-lint.query.watch.enable` | `false` | **Watch Query**: re-run a query every few seconds, its result refreshed in place. Off, the command refuses and a watch running stops. | - |
| `q-lint.query.watch.interval` | `5` | Seconds between a watched query's runs that **Watch Query** offers, 1 to 86400. | - |
| `q-lint.processExplorer.excludedNamespaces` | `["q","Q","h","j","o","s"]` | Namespaces the Process Explorer and live completion leave out (`q`, or a nested one as `ns.sub`), with those nested in them. | - |
| `q-lint.processExplorer.previewLimit` | `5` | Rows of a table Preview shows. | - |
| `q-lint.processExplorer.autoRefresh` | `false` | Read the process again after each query. | - |
| `q-lint.queryHistory.search.enable` | `true` | **Filter Query History** and **Export Query History**. | - |
| `q-lint.processExplorer.functionSource.enable` | `true` | Open Function Source, Edit and Redefine, Redefine on Process. | - |
| `q-lint.processExplorer.findCallers.enable` | `true` | Find Callers in Process. | - |
| `q-lint.processExplorer.tableHover.enable` | `true` | A table's details in its Process Explorer tooltip. | - |
| `q-lint.processExplorer.editorTableHover.enable` | `false` | A table's details on hovering its name in a q editor; asks the process. | - |
| `q-lint.processMonitor.enable` | `true` | The Process Monitor view. | - |
| `q-lint.processMonitor.refreshInterval` | `0` | Seconds between the Monitor's reads while it is shown; `0` none. | - |
| `q-lint.hdbBrowser.enable` | `true` | The HDB Browser view. | - |
| `q-lint.testExplorer.enable` | `true` | List q tests (`test_*`, qUnit `testName`, k4unit CSV suites) in the Testing view and run them on a q process. Off, none is listed, read or sent. | - |
| `q-lint.liveValueHover.enable` | `false` | Show a global's value on the connected process when hovering it in a q editor. Off, no hover is registered and nothing is sent. | - |
| `q-lint.undefinedNames.enable` | `false` | Warn on globals a q file reads that neither the workspace nor the connected process defines, and offer **Check Undefined Names on Process**. Off, nothing is sent and the command is hidden. | - |
| `q-lint.idiomSnippets.enable` | `true` | Offer the idiom snippets (joins, `.z` handlers, a TorQ process) in the completion list. | - |
| `q-lint.processExplorer.driftDetection.enable` | `false` | **Check Drift Against Process**: compare the workspace's function definitions with the connected process. Off, the command is hidden and reads nothing. | - |
| `q-lint.hotReload.enable` | `false` | On saving a q file, send the definitions the save changed to its process, after Redefine's confirmation. Off, nothing listens and nothing is sent. | - |

### Connection settings

Each applies at once, without a reload. None reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.connection.connectScript.enable` | `true` | Run a process's connect script on every connect; off, none runs and **Set Connect Script** is hidden. | - |
| `q-lint.connection.heartbeat.enable` | `false` | Send a heartbeat on the active connection and show its round trip in the status bar. | - |
| `q-lint.connection.heartbeatInterval` | `30` | Seconds between heartbeats. | - |
| `q-lint.connection.autoReconnect.enable` | `false` | Reconnect a connection the process or the network dropped, with backoff. | - |
| `q-lint.connection.reconnectAttempts` | `5` | Tries before a reconnect gives up. | - |

### Process connection settings

Each applies at once, without a reload. None reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.connection.sshTunnel.enable` | `true` | Reach a process that names a jump host through `ssh -N -L`; off, **Set SSH Tunnel** is hidden and such a process is not connected to. | - |
| `q-lint.connection.torqGateway.enable` | `true` | Send a TorQ gateway's queries through `.gw.syncexec`; off, they go as written and **Set Gateway Server Types** and **Query Gateway on Server Types...** are hidden. | - |
| `q-lint.tickerplant.stream.enable` | `false` | **Stream Tickerplant Table**: subscribe with `.u.sub` and show a table's updates live. Off, the command is hidden and refuses, and open streams close. | - |
| `q-lint.tickerplant.stream.rows` | `1000` | The newest rows a stream keeps, 1 to 10,000. | - |
| `q-lint.processes.launcher.enable` | `true` | **Start Process**, **Stop Process** and **Set Launch Definition**. Off, they are hidden and refuse, and what was started is stopped. | - |
| `q-lint.processes.shared.enable` | `true` | Read, watch and list `.qlint/processes.json`, and offer **Add to Shared Process List**. Off, the file is not read and the group is removed. | - |

### Terminal settings

Read when a q terminal starts, so a change applies to the next one. None
reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.terminal.qBinary` | `"q"` | The q binary a terminal starts: a name on `PATH` or a path, where a leading `~` is your home directory. It is quoted for the terminal's shell (POSIX, PowerShell or cmd), so it names one program, not a command with arguments. | `q-terminal.cfg.qBinary` |
| `q-lint.terminal.envPath` | `""` | A file of `NAME=value` lines set for q, such as `QHOME` and `QLIC`. They go on the command line that starts q (`NAME=value q`, `$env:NAME=` in PowerShell, `set` in cmd), so they win over what your shell's startup files set, and show there. Relative to the workspace folder; a leading `~` is your home directory. It is read, not run as a shell script as q-pro's is: `#` lines are comments, `export ` is allowed, quotes around a value are dropped, and nothing is expanded: `$HOME` stays `$HOME`. | `q-terminal.cfg.envPath` |

### q environment settings

Read when they are used, so a change needs no reload. None reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.interpreter.enable` | `true` | **Select q Interpreter** and its status bar item. Off, both are hidden, and no q is started to ask its version; a binary's install no longer sets `QHOME`. | - |
| `q-lint.licence.expiryWarning.enable` | `true` | The licence expiry warning and **Check q Licence Expiry**. The date is the one q reports in `.z.l`, kept on this machine; the licence file is never read. Off, nothing warns and the command is hidden and refuses. | - |
| `q-lint.licence.warningDays` | `30` | Days before the expiry date the warning starts, 0 to 365. | - |
| `q-lint.env.enable` | `true` | Give the `.env` file's variables to the q terminals, launched processes and q tasks, in their environment, never shown. Off, the file is not read. | - |
| `q-lint.env.file` | `".env"` | The `.env` file: relative to the workspace folder, which may set its own; a leading `~` is your home directory. | - |
| `q-lint.tasks.enable` | `true` | The `q` task type: detected **run current file** and **test** tasks, and `q` tasks in `tasks.json`. Off, the provider is unregistered and no q task runs. The `$q` problem matcher stays, inert unless a task names it. | - |

### Discovery settings

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.discovery.refreshInterval` | `30` | Minutes between fetches of every discovery server, at most 1440. `0` fetches a server only on **Reload Discovery Server**, and when it is added or edited. | - |

### Notebook settings

Read when a cell runs or a command is used, so a change needs no reload. None reaches the language server.

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.notebook.rowLimit` | `1000` | The most rows of a table a `@grid` or `@chart` cell is sent; `0`: every row. | - |
| `q-lint.notebook.rowLimitFrom` | `"first"` | Which rows of a larger table a cell shows: `first` or `last`. | - |
| `q-lint.notebook.variables.enable` | `true` | The **Notebook Variables** view. It reads only after a cell runs or on Refresh, while it is open; off, it is removed and reads nothing. | - |
| `q-lint.notebook.parameters.enable` | `true` | **Run Notebook with Parameters** and `/ @parameters`. Off, the command is hidden and refuses, and a `/ @parameters` cell is not run. | - |
| `q-lint.notebook.export.enable` | `true` | **Export Notebook as HTML**, **as Jupyter Notebook** and **Import Jupyter Notebook**. Off, they are hidden and refuse. | - |
| `q-lint.notebook.liveValues.enable` | `true` | Read `{{q: expr}}` in Markdown cells when the code cell above runs; never on their own. Off, nothing is sent. | - |
| `q-lint.notebook.processDirective.enable` | `true` | `/ @process <label>`. Off, a cell with it is not run and nothing is sent. | - |

### Agent settings

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.agent.queryTimeout` | `30` | Seconds a query run by an agent through **Run q Query** may take before it is aborted, as **Abort Current Query** aborts one. `0` sets no limit. | - |
| `q-lint.agent.schemaTool.enable` | `true` | The **List q Tables** tool: the connected process's tables, or one table's schema. Off, it is unregistered. | - |
| `q-lint.agent.lintTool.enable` | `true` | The **Lint q Code** tool: qlinter's findings on code an agent gives it. Off, it is unregistered. | - |
| `q-lint.chat.participant.enable` | `true` | The **@q** chat participant. Off, it is removed from the chat. | - |
| `q-lint.chat.englishToQsql.enable` | `true` | **Draft qSQL from a Description**, shown for review and run only on **Run**. Off, the command is hidden and refuses. | - |

### Process settings

| Setting | Default | What it does | q-pro |
| --- | --- | --- | --- |
| `q-lint.processes.tagColors` | `{}` | A tag's colour in the Processes view, as a theme colour id: `{"eu": "charts.purple"}`. Over the built-in `prod`, `uat` and `dev` colours; a value that is not a colour id is ignored. Changing it recolours the view at once. | - |
| `q-lint.processes.readOnlyGuard.enable` | `true` | Ask before sending code that would change a process carrying a guarded tag; refuse an agent's. Off, code is sent unasked. | - |
| `q-lint.processes.readOnlyGuard.tags` | `["prod","prd","production"]` | The tags the read-only guard guards, ignoring case; `[]` guards none. | - |

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
