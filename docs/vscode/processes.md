# Processes and connections

Reference for the q-lint VS Code extension's process list: the file format,
discovery servers, the shared list, and how a connection is made. The
[extension README](../../editors/vscode/README.md) covers what each command
does.

## The process list format

**Import Processes** and **Export Processes**, a discovery server, and a
shared `.qlint/processes.json` all use one JSON format: a list of processes,
or an object with a `processes` list.

```json
{
  "processes": [
    {"label": "rdb", "host": "localhost", "port": 5010, "tags": ["dev"]},
    {"label": "gw", "host": "gw.example", "port": 6000, "user": "me", "tls": true,
     "tags": ["prod"], "gateway": ["rdb", "hdb"], "evaluation": "direct"}
  ]
}
```

| field | meaning |
|---|---|
| `label` | Unique name. The view, the status bar and the history show it. |
| `host`, `port` | Where the process listens. |
| `user` | Sent in the handshake. The password is never in the file: it is kept in VS Code's SecretStorage and asked for on the first connect. |
| `tags` | Group and colour the Processes view. `prod`, `prd` and `production` turn on the read-only guard. |
| `tls` | `true` for a process started with `-E 1` or `-E 2`. |
| `init` / `initFile` | A connect script: q code, or a q file, run on every connect before any query. |
| `ssh` | A jump host (`bastion`, `me@bastion:2222`). See [SSH tunnels](#ssh-tunnels). |
| `gateway` | Marks a TorQ gateway, with the server types its queries go to (`["rdb", "hdb"]`). See [TorQ](torq.md). |
| `evaluation` | `"wrapped"` or `"direct"`. See [Safety and evaluation](safety.md#wrapped-and-direct-evaluation). |
| `launch` | How to start the process on this machine. See [Launch definitions](#launch-definitions). |
| `credentialCommand` | A command that prints the credentials at each connect. See [Credential commands](#credential-commands). |
| `timeout` | Seconds a query on this process may run, over `q-lint.query.timeout`. |

An import replaces processes of the same label and adds the rest. It asks
before an entry would remove a process's TLS, SSH tunnel or a guarded tag. A
process that moves to another host, port or user forgets its stored password.

A discovery server's list never brings `init`, `initFile`, `ssh`, `launch`
or `credentialCommand`: those run something on your machine or your
process.

## Discovery servers

A discovery server is a URL that answers a `GET` with the format above. Add
one with **Add Discovery Server** (a label, a URL, and an optional auth
header kept in secret storage, sent as `Authorization` or as `Name: value`).
Its processes appear in a **Discovery Servers** group, in memory only, and
are fetched again every `q-lint.discovery.refreshInterval` minutes and on
**Reload Discovery Server**. **Download Processes** saves them to your list.

A fetch waits at most 10 seconds and accepts a 2xx `application/json` answer
of up to 5 MB. A failure is shown under the server's row.

A discovered process is `server/label` once connected, so it is never
confused with a saved process of the same label.

## The shared process list

A `.qlint/processes.json` in the workspace folder, committed with the code,
lists a team's processes for everyone who opens the repository. Its
processes show in a **Workspace: .qlint/processes.json** group, are
`.qlint/label` once connected, and the file is re-read when it changes.

- A `password`, `secret`, `token` or similar field is ignored, with a
  warning.
- Connect scripts, SSH jump hosts, launch definitions and credential
  commands are read only in a trusted workspace.
- **Add to Shared Process List**, on a saved process, writes it there,
  without its password. A connect script, credential command or launch
  definition is shared only if you agree.

## Adding many processes

**Add Many Processes...** takes one process per line, `host:port[:label[:tags]]`
(`[::1]:5000:local` for IPv6), or CSV with a header naming `host`, `port`
and any of `label`, `tags`, `user` and `tls`. A table shows what each line
gives before you add. Passwords are never read from what you paste.

**Import Servers from qStudio...** reads qStudio's **Copy Server List**
text, its `<serverlist>` XML or its preferences file. **Import Connections
from KX Extension...** reads `kdb.servers` from your settings or a file KX's
**Export Connections** wrote; its labels become tags. A multi-word label or
folder becomes one tag joined by `-` (`Non Prod` is `non-prod`, which is not
guarded); a guarded word in it (`Prod EU`) also becomes a `prod` tag. No
password is imported.

## Connecting

- **Set Connect Script** runs q code or a q file on every connect, reconnects
  included. A file inside the workspace is kept relative to it. A failing
  script warns and keeps the connection.
- **Choose Connection for File** binds a file to a process; a query from it
  switches the active connection there first. **New Query for Process**
  opens an untitled editor already bound. **Open Scratch Buffer** opens a
  per-process q file kept in the extension's storage.
- `q-lint.connection.heartbeat.enable` sends `::` every
  `q-lint.connection.heartbeatInterval` seconds and shows the round trip.
  `q-lint.connection.autoReconnect.enable` reconnects a dropped connection
  with back-off. Both are off by default.

### SSH tunnels

**Set SSH Tunnel** names a jump host. Each connect runs
`ssh -N -L 127.0.0.1:<free port>:<host>:<port> -- <jump host>` in batch
mode, so it uses your agent and `~/.ssh/config` and never asks for a
password. The process's host and port are as the jump host sees them. The
tunnel closes with the connection.

### Credential commands

**Set Credential Command** gives a process a shell command run at each
connect, for a Kerberos ticket, a vault or a token service. It prints either
a JSON object with `password` (or `token`) and optionally `user` (or
`username`), or one line: the password when the process has a user, else
`user:password`, else the password. It runs in the workspace folder with
`QLINT_PROCESS_LABEL`, `QLINT_PROCESS_HOST`, `QLINT_PROCESS_PORT` and
`QLINT_PROCESS_USER` set, and has 30 seconds. Its output is used for that
connect only and stored nowhere; a failure reports only the exit code or
the timeout.

### Launch definitions

**Set Launch Definition** lets **Start Process** start a local q or TorQ
process. In the file it is `launch`:

```json
{"launch": {"command": "q", "script": "torq.q",
  "args": ["-proctype", "rdb", "-procname", "rdb1", "-load", "code/processes/rdb.q"],
  "cwd": "~/torq", "env": {"KDBCODE": "code", "KDBCONFIG": "config"}}}
```

It runs `<command> <script> -p <port> <args>` (`command` defaults to
`q-lint.terminal.qBinary`; `-p` is left out when `args` sets it), with its
output in a `q: <label>` output channel. Only a process on this machine
whose port is free is started. **Stop Process** stops only what was started
from VS Code (SIGTERM, then SIGKILL after 3 seconds), and everything started
is stopped when VS Code closes. **Interrupt Query on Local Process** sends
such a process SIGINT, which stops the running query and keeps the
connection (not on Windows).

## Labels

A query, a keybinding argument or an agent names a process by its label.
A bare label means a saved process first, then a discovered one if only one
server lists it. `server/label` names a discovered process and
`.qlint/label` a shared one. **Copy Label for Agent Query** copies the right
form.

## Process admin switches

Each of these features has its own switch. Off, its commands are hidden and
it sends nothing.

| setting | default | turns on |
|---|---|---|
| `q-lint.processes.bulkAdd.enable` | `true` | **Add Many Processes...** |
| `q-lint.processes.importOther.enable` | `true` | **Import Servers from qStudio...** and **Import Connections from KX Extension...** |
| `q-lint.connection.credentialCommand.enable` | `true` | **Set Credential Command**; off, stored passwords are used |
| `q-lint.processes.environmentColor.enable` | `false` | A status bar item and editor border in the colour of the connected process's tag |
| `q-lint.processes.environmentColor.colors` | `prod`/`prd`/`production` red, `uat` amber | The colour of each tag: `red`, `amber`, `yellow`, `purple`, `blue`, `green` or `#rrggbb` |
| `q-lint.query.processTimeout.enable` | `true` | **Set Process Timeout** |
| `q-lint.query.cancelLocal.enable` | `true` | **Interrupt Query on Local Process** |
| `q-lint.query.async.enable` | `true` | **Run Query Asynchronously** and **Show Pending Async Queries** |
| `q-lint.query.links.enable` | `true` | **Copy Query Link**, and opening `vscode://wojdalski.q-lint/query` links |
| `q-lint.export.schedule.enable` | `false` | **Add Scheduled Export...** and **Manage Scheduled Exports...**, and running them while VS Code is open |
| `q-lint.connectedClients.enable` | `true` | The **Connected Clients** view |
| `q-lint.timers.enable` | `true` | The **Timers** view |
