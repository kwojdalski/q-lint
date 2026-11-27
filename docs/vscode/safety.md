# Safety and evaluation

What the q-lint VS Code extension sends to a q process, and the controls
around it. The [extension README](../../editors/vscode/README.md#safety)
has the summary.

## At a glance

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

## What is sent, and when

- **The linter sends nothing.** Linting, Quick Fixes, navigation, hovers and
  completion read the source and a catalogue of q's words that ships with
  the server. The server starts no process.
- **A process is contacted only when you add it and connect.** Your queries
  go there, plus q-lint's own reads: the Process Explorer, Process Monitor,
  HDB Browser, hovers and similar views. Each read is a fixed lambda that
  defines nothing on the process.
- **Features that act on their own are off by default**: Watch Query,
  streaming a tickerplant table, scheduled exports, the heartbeat,
  auto-reconnect, hot reload on save, Smart Send, live value hovers,
  undefined-name checks, process names in symbol search, the editor's
  table hover, live completion, drift detection, result paging, running
  affected tests on save, and defining `.qlint.view` on connect.
- **Every feature has its own `enable` setting.** Off, its view is hidden,
  its commands are hidden and refuse, its provider is unregistered, and it
  sends nothing.

## Wrapped and direct evaluation

By default q-lint sends your code inside a small lambda of its own
(**wrapped**). The lambda splits the code into statements, formats the
result with q's own console rules, and returns a backtrace on error.

Some processes refuse a lambda: a gateway that accepts only strings, or TorQ
with permissions on, where `.pm` rejects one. For those, use **direct**
evaluation: the code goes as plain strings, one per statement, stopping at
the first error, and q-lint formats the result itself.

- **Set Process Evaluation**, on a process row, sets `"evaluation":
  "direct"` or `"wrapped"` for that process. It wins over the setting.
- **Toggle Unwrapped Query**, or `q-lint.query.unwrapped`, sets the default
  for processes that name neither.
- The status bar shows `direct` (or `unwrapped`), and the connection's
  tooltip says which mode applies.

| | wrapped | direct |
|---|---|---|
| Works where a lambda is refused | no | yes |
| Backtrace on error | yes | no |
| Result formatting | q's console (`.Q.S`, `\P`) | q-lint's, floats at 7 digits |
| Result paging | yes | no |
| Read-only evaluation (`reval`) on a guarded process | yes | no |
| `\d` lasts across statements | yes | only within one statement |

Queries, the REPL, the Interactive Window, Smart Send, notebook cells, live
values, the connect script and the agent tool all follow the mode. Features
that need the lambda (Benchmark, Time Lines, snapshots, Explain aj Match,
Run Query Asynchronously, logpoints and others) refuse on a direct process
and say why. The Process Explorer reads a direct process only on
**Refresh Process Explorer**, with plain requests, and shows names and
kinds only.

`qnbrun.js --direct` does the same for a notebook run from a shell.

## The read-only guard

Code sent to a process carrying a tag in
`q-lint.processes.readOnlyGuard.tags` (`prod`, `prd`, `production` by
default, ignoring case) is read first. When it would change the process, a
modal asks before anything is sent; Escape sends nothing.

A change includes assigning a global, `update` or `delete` on a table named
by symbol, `set`, `upsert`, `insert`, writing a file, `system` and most
system commands, `exit`, `hclose`, the `.Q` functions that write to disk,
amends in place, and `value` or `eval` of a string. Reading a setting
(`\c`, `\d`, `\P`, `\w` and similar) is not a change.

The guard covers every path that sends your code: queries, reruns, saved and
watched queries, Query a Tag, Compare Query, notebook cells, Redefine and
hot reload, connect scripts, drill-downs, wrangle steps, cell edits, data
file loads, test runs and TorQ gateway calls (read inside the
`.gw.syncexec` string). An agent's query that would change a guarded
process is refused, not offered to you. Close Client Handle is refused
outright on a guarded process.

The guard reads text. It does not see a function defined earlier that
writes, or a string built at run time and evaluated. It protects against a
slip, not against a person: a process that must not change needs its own
`.z.pg`. `q-lint.processes.readOnlyGuard.enable` turns it off.

## Read-only evaluation (`reval`)

So that a write the guard misses is still not made, code the guard reads as
read-only is evaluated on a guarded process under `reval`, q's read-only
evaluation (`q-lint.processes.readOnlyGuard.enforce`, on by default). The
process refuses a global assignment (`'noupdate`), file access (`'access`),
a system command that sets something (`'sys`) and a message to itself
(`'restricted`), and the process is left unchanged.

Some reads change something on the way - a function that caches into a
global, the first `.Q.ind` on a partitioned table - and q refuses them too.
q-lint then asks "Run it anyway?" and resends only if you confirm. An
agent's query, a scheduled export or a dashboard refresh gets the refusal
as its error.

`reval` does not apply to a TorQ gateway (whose `.gw.syncexec` changes the
gateway's own state), to direct evaluation, or to a process without
`reval`, where the guard alone holds.

## Production confirmations

Besides the guard, some actions ask before acting on a process tagged
`prod`, `prd` or `production`: connecting from a notebook's `/ @process`
cell, running tests from the Testing view, setting a connect script,
streaming a tickerplant table, starting Watch Query, and the agent tool,
which warns that the query runs on production.

## Restricted Mode

In a folder VS Code does not trust, linting, Quick Fixes, navigation and
colouring work as usual: the linter never runs what it reads. What could
run a program the folder chooses is held back:

- These settings are read from your user settings only, never the folder's:
  `q-lint.serverPath`, `q-lint.serverArgs`, `q-lint.profile`,
  `q-lint.configFile`, `q-lint.terminal.qBinary`, `q-lint.terminal.envPath`,
  `q-lint.env.enable`, `q-lint.env.file`, `q-lint.processes.launcher.enable`,
  `q-lint.connection.credentialCommand.enable`,
  `q-lint.processes.readOnlyGuard.enable`,
  `q-lint.processes.readOnlyGuard.tags`,
  `q-lint.processes.readOnlyGuard.enforce`,
  `q-lint.testing.runAffectedOnSave.enable` and
  `q-lint.results.drilldownTemplates`.
- The folder's `.env` is not given to q, and **Select q Interpreter** does
  not offer or run a q binary inside the folder.
- git is not run: formatting changed lines, the Problems Dashboard's trend,
  comparing a notebook with git, the notebook strip filter and listing
  affected tests say so instead.
- A shared `.qlint/processes.json` loses its connect scripts, launch
  definitions and credential commands, and an entry reached through an SSH
  tunnel is not listed.

Queries still go to the processes you saved.
