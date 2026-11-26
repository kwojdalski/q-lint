# TorQ

How the q-lint VS Code extension works with
[TorQ](https://github.com/DataIntellectTech/TorQ) processes: gateway
queries, starting processes, logs and tickerplant tools. The
[extension README](../../editors/vscode/README.md#torq) has the summary.

## Gateway queries

**Set Gateway Server Types**, on a process row, marks a process as a TorQ
gateway and names the server types its queries go to (`rdb hdb`). Empty
unmarks it. In a process file it is `"gateway": ["rdb", "hdb"]`.

A query to a gateway is sent as `.gw.syncexec[query;servertypes]`, so the
gateway runs it on a server of each type and joins the answers. The server
types are chosen in this order:

1. Those **Query Gateway on Server Types...** asks for, for the selection or
   the current line.
2. A line at column 0 of the file: `/ @servertypes hdb`. A comment after the
   types is ignored. `/ @servertypes none` sends the file's queries to the
   gateway itself. A query saved from such a file keeps the line, so its
   runs, scheduled exports and dashboard tiles go to the same types.
3. The process's own server types.

Server types are q names: one that is not (`hdb-eu`, `2hdb`) is named and
refused, and a file whose line holds one sends none of its queries.

Several statements are joined into one string, so a server in TorQ's
read-only mode still accepts it; with a `\d` among them they go as a list
of strings valued in turn, so a function defined after the `\d` lands in
its namespace. `.gw.syncexec` defers its reply on kdb+
3.6 and later, so the call is sent as a plain string and q-lint formats the
value, as in direct evaluation.

Code that calls the gateway's own API or reads its state - any name in `.gw`
or `.dataaccess`, such as `.gw.servers`, or the state every TorQ process
keeps in `.servers`, `.clients`, `.timer` and `.kxdash` - is sent as
written: `select from .servers.SERVERS` reads the gateway's own discovery.
A selection is read statement by statement, so the gateway's own statements
(and those tied to them by a name, `count t` under `t:.gw.syncexec[...]`)
go as written and the rest through `.gw.syncexec`. The history keeps the
call as sent, and a rerun does not wrap it twice.

Dashboards, scheduled exports, Query a Tag, Compare Query, Watch Query, the
REPL, the Interactive Window, Smart Send, notebook cells and live values,
the agent tool, Copy Value as JSON and SQL all route through the gateway;
a code cell, Smart Send and Copy Value as JSON use the server types their
file names. A
drill-down, wrangle step or cell edit goes to the server types its result
came from. Features that evaluate inside q-lint's own lambda (Run Query
Asynchronously, snapshots, Explain aj Match, Benchmark, Time Lines, Profile
Functions, the Join Assistant) refuse gateway-routed code rather than run it
on the gateway. The Process Explorer lists the gateway's own names, so its
**Preview** and **Table Templates...** read the gateway's tables.

`q-lint.connection.torqGateway.enable` off sends every query as written.

### TorQ with permissions on

TorQ's permissions (`.pm`) reject q-lint's lambda. Set **Set Process
Evaluation** to `direct` on such a process. See
[wrapped and direct evaluation](safety.md#wrapped-and-direct-evaluation).

## Starting TorQ processes

A launch definition starts a TorQ process from the Processes view with
**Start Process**:

```json
{"launch": {"script": "torq.q",
  "args": ["-proctype", "rdb", "-procname", "rdb1", "-load", "code/processes/rdb.q"],
  "cwd": "~/torq", "env": {"KDBCODE": "code", "KDBCONFIG": "config"}}}
```

See [launch definitions](processes.md#launch-definitions). The `torq` idiom
snippet writes a process skeleton: its namespace, a setting, `init` calling
`.servers.startup` and a `.timer.repeat` job.

## Logs

**Open Log File...** (palette, or a `.log`, `.out` or `.err` file in the
Explorer) opens one or more logs in a read-only editor, coloured by level
and followed as they grow (**Follow or Pause Log**). It reads:

- TorQ's `.lg.format` lines (`time|host|proctype|proc|LEVEL|id|message`) and
  their `-jsonlogs` form;
- TorQ usage logs, where status `e` is an error;
- plain q output: q's errors with their backtrace, and lines with a
  timestamp and a level word.

Several files open as one view, merged by time; a TorQ `out_rdb1_...log`
file name gives its process. **Filter Log by Level...**, **Filter Log by
Process...**, **Filter Log by Time...** and **Filter Log by Text...** narrow
the view; **Clear Log Filters** resets it. The view keeps the last
`q-lint.processes.logViewer.maxLines` entries that pass the filter. Nothing
is sent to any process.

## Tickerplant tools

- **Stream Tickerplant Table** (off by default:
  `q-lint.tickerplant.stream.enable`) subscribes to a table with
  ``.u.sub[table;`]`` on a connection of its own and shows updates live in a
  grid, newest first, keeping `q-lint.tickerplant.stream.rows` rows.
  Closing the grid unsubscribes. While it waits for the table list or for
  `.u.sub`, a notification says so; its Cancel, **Abort Current Query** or
  **Disconnect** gives up, and the wait is bounded by the process's query
  timeout (60 seconds with none).
- **Tickerplant Subscribers**, a view, shows `.u.w` by table: each
  subscriber's handle, host and output queue.
- **Open Tickerplant Log...** reads a tickerplant log in a separate q,
  started on the loopback in a temporary directory. You can filter and step
  through messages and **Replay** a range into that q (after **Load
  Schema...** if needed). Nothing is sent to your processes.

## Process views that read TorQ state

- **Connected Clients** shows `.z.W` handles, with the user and host where
  TorQ's `.clients` records them. **Close Client Handle** asks first, and is
  refused on a guarded process.
- **Timers** shows `\t`, `.z.ts`, and TorQ's `.timer.timer` jobs with their
  period, next and last run. **Turn Timer On/Off** sets a job's `active`
  flag; **Set Timer Interval (\t)** sets `\t`.
- **Process Monitor** shows memory, handles, the timer (including
  `.timer.timer`), `\` settings, version, pid and host.
