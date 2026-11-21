# qlint-kernel: a Jupyter kernel for q

Runs the cells of a Jupyter notebook - in JupyterLab, Notebook, VS Code's
Jupyter support, `nbclient` or any other Jupyter frontend - on a q process,
over q's IPC protocol. It is plain Python and [pyzmq](https://pypi.org/project/pyzmq/);
it needs no PyKX and no q-side library, and defines nothing on a process it
connects to.

## Install

```sh
pip install "git+https://github.com/kwojdalski/q-lint#subdirectory=editors/jupyter"
python -m qlint_kernel install --q q                      # each kernel starts its own q
python -m qlint_kernel install --connect localhost:5001   # or runs on one already running
```

`install` writes the kernel spec `q-lint` ("q (q-lint)") for this user; `--sys-prefix`
or `--prefix DIR` put it elsewhere, `--name` and `--display-name` rename it,
and `--env NAME=VALUE` passes `QHOME`, `QLIC` or anything else the kernel and
its q need. A spec already there is replaced only with `--replace`.

- `--q "COMMAND"`: each kernel starts that q (a command line, so
  `--q "env QHOME=/opt/q /opt/q/m64/q"` works) listening on a free port of
  the loopback, and stops it when the kernel stops. Restarting the kernel
  starts a fresh q. What q writes to stdout and stderr shows in the cell.
- `--connect HOST:PORT`: cells run on that process, which the kernel never
  stops. `--user-name USER` logs in as USER with the password in
  `QLINT_Q_PASSWORD`; a password is never an argument or in the spec.
- `--console-size ROWS COLS` (100 200): the size results are formatted at.

## What a cell does

A cell is cut into statements as q reads a script - an indented line
continues the one above, `/` comments and `/` ... `\` blocks are skipped -
and they run in order with `value`, as in q's console. The last value shows
as q formats it, at the console size; `::`, such as an assignment ending in
`;`, shows nothing. An error shows q's message and, on kdb+ 3.5 and later,
its backtrace. Tab completes names on the process (globals, q's keywords,
namespaces and their names), Shift-Tab shows a name's value, and a console
asks for a continuation line while a bracket is open.

Interrupt stops a cell: a q the kernel started gets SIGINT, as Ctrl-C in its
console, and the cell fails with `'stop`. From a process it connected to,
the kernel stops waiting and reconnects on the next cell; the process may
still be running what it was sent.

## Not here

No rich output (a table shows as text), no widgets or comms, no stdin
(`read0 0` cannot be answered), no debugger, and no history kept by the
kernel. The VS Code extension's read-only guard does not apply: the kernel
sends what the cell says.

## Tests

```sh
python -m unittest discover -s editors/jupyter/tests          # the codec and statements
QLINT_TEST_Q=q uv run --no-project --with pyzmq --with jupyter_client \
    python -m unittest discover -s editors/jupyter/tests      # the kernel, through jupyter_client
```
