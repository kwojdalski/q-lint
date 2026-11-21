"""A Jupyter kernel for q: the messaging protocol over ZeroMQ, forwarding each
cell to a q process over IPC.

The process is either one the kernel starts for itself (``--q``: a q binary
or command line, listening on a free port of the loopback, stopped with the
kernel), or one it connects to (``--connect host:port``). A cell is cut into
statements as q reads a script and sent with one lambda - the VS Code
extension's - that runs them with ``value`` and answers with the last value
as the process formats it, at the console size, or the error and its
backtrace. Nothing is defined on a process the kernel connects to; on one it
starts, ``.z.pc`` is set so the process ends when the kernel's connection
closes, even when the kernel is killed.

What the protocol asks of a kernel and this one does: kernel_info, execute
(results, errors and, on a process it started, what q writes to stdout and
stderr), complete (names on the process), inspect (a name's value),
is_complete (open brackets), interrupt (``interrupt_mode`` "message": a
started process gets SIGINT, as Ctrl-C in its console; from a process it
connected to, the kernel stops waiting and reconnects on the next cell),
history (none kept), comm_info (no comms) and shutdown.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone

import zmq

from . import __version__
from .qipc import Closed, QConnection, QError, Symbol
from .statements import is_complete, statements

PROTOCOL = "5.3"
DELIMITER = b"<IDS|MSG>"

# The lambda the VS Code extension's queries send (query.ts's RUN): the
# statements in order with `value`, the last value formatted by the process
# at the console size, or the error and its backtrace (kdb+ 3.5 and later).
RUN = "\n".join(
    [
        "{[s;size]",
        " r:$[`trp in key `.Q;",
        "   .Q.trp[{(1b;last value each x)};s;{(0b;x;.Q.sbt -4_y)}];",
        '   @[{(1b;last value each x)};s;{(0b;x;"")}]];',
        " $[r 0;",
        '   `ok`type`text!(1b;type r 1;.Q.S["j"$size;0j] r 1);',
        "   `ok`error`trace!(0b;r 1;r 2)]}",
    ]
)

# Names for completion, read-only: the root's functions and variables, q's
# reserved words and .q's functions, and the namespaces; or a namespace's
# names, each with the namespace in front.
COMPLETE = (
    "{[ns] $[null ns;"
    ' (raze string each (system "f";system "v";.Q.res;1_key .q)),".",/:string (key `) except `;'
    " string ` sv/: ns,/:k where not null k:@[key;ns;{`$()}]]}"
)

# A name's value as -3! writes it, cut; read-only.
INSPECT = '{[n] @[{(1b;2000 sublist -3!value x)};n;{(0b;x)}]}'

# On a process the kernel started: end it when the kernel's connection closes.
WATCH = "{.z.pc:{[h;x] if[x=h;exit 0]}[.z.w];}[]"

NULL_TYPE = 101
NAME = re.compile(r"[.a-zA-Z][\w.]*$")
NAME_AFTER = re.compile(r"^[\w.]*")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Backend:
    """The q process the kernel runs cells on."""

    def __init__(self, connect: str | None, q: list[str] | None, user: str | None, console_size: tuple[int, int]):
        self.user = user
        self.password = os.environ.get("QLINT_Q_PASSWORD") if user else None
        self.size = [float(console_size[0]), float(console_size[1])]
        self.conn: QConnection | None = None
        self.child: subprocess.Popen | None = None
        self.interrupted = False
        self.problem: str | None = None
        self._out: list[tuple[str, str]] = []
        self._out_lock = threading.Condition()
        if connect is not None:
            host, _, port = connect.rpartition(":")
            self.host = host or "localhost"
            self.port = int(port)
        else:
            self.host = "127.0.0.1"
            self.port = free_port()
            self._start(q or ["q"])

    @property
    def where(self) -> str:
        return f"{self.host}:{self.port}"

    @property
    def started(self) -> bool:
        return self.child is not None

    def _start(self, command: list[str]) -> None:
        try:
            self.child = subprocess.Popen(
                [*command, "-q", "-p", f"127.0.0.1:{self.port}"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as error:
            self.problem = f"could not start {shlex.join(command)}: {error}"
            return
        for name, pipe in (("stdout", self.child.stdout), ("stderr", self.child.stderr)):
            threading.Thread(target=self._read, args=(name, pipe), daemon=True).start()
        until = time.monotonic() + 15
        while time.monotonic() < until:
            if self.child.poll() is not None:
                self.problem = f"{shlex.join(command)} ended with code {self.child.returncode} before it listened: {self._take_text()}".strip()
                return
            try:
                self.conn = QConnection(self.host, self.port, timeout=2)
                break
            except OSError:
                time.sleep(0.1)
        else:
            self.problem = f"{shlex.join(command)} did not listen on port {self.port} within 15 s"
            return
        self.conn.call(WATCH)
        self._take()

    def _read(self, name: str, pipe) -> None:
        for raw in iter(pipe.readline, b""):
            with self._out_lock:
                self._out.append((name, raw.decode("utf-8", "replace")))
                self._out_lock.notify_all()

    def _take(self) -> list[tuple[str, str]]:
        with self._out_lock:
            out, self._out = self._out, []
        return out

    def _take_text(self) -> str:
        return "".join(text for _name, text in self._take())

    def connection(self) -> QConnection:
        if self.problem is not None:
            raise ConnectionError(self.problem)
        if self.conn is None or not self.conn.is_open:
            if self.started and self.child.poll() is not None:
                raise ConnectionError(f"the q process the kernel started ended (code {self.child.returncode}): restart the kernel")
            self.conn = QConnection(self.host, self.port, self.user, self.password)
        return self.conn

    def output(self) -> list[tuple[str, str]]:
        """What a process the kernel started wrote while the cell ran: up to a
        line asked for after it, so nothing of the cell's comes later."""
        if not self.started or self.conn is None or not self.conn.is_open:
            return self._take()
        mark = f"qlint-kernel-{uuid.uuid4().hex}"
        try:
            self.conn.call(f'-1 "{mark}";')
        except (QError, Closed):
            return self._take()
        until = time.monotonic() + 2
        with self._out_lock:
            while not any(text.rstrip("\n") == mark for _n, text in self._out) and time.monotonic() < until:
                self._out_lock.wait(0.05)
            at = next((i for i, (_n, text) in enumerate(self._out) if text.rstrip("\n") == mark), None)
            if at is None:
                out, self._out = self._out, []
            else:
                out, self._out = self._out[:at], self._out[at + 1 :]
        return out

    def run(self, code: str):
        """The answer to ``code``: None when it has no statements, else the
        RUN lambda's dictionary."""
        cut = statements(code)
        if not cut:
            return None
        self.interrupted = False
        conn = self.connection()
        return conn.call(RUN, cut, self.size)

    def complete(self, prefix: str) -> list[str]:
        ns = prefix[: prefix.rindex(".")] if "." in prefix[1:] else ""
        if ns and not ns.startswith("."):
            return []
        names = self.connection().call(COMPLETE, Symbol(ns))
        if isinstance(names, str):
            names = [names]
        return sorted({n for n in names if isinstance(n, str) and n.startswith(prefix)})

    def inspect(self, name: str) -> str | None:
        ok, text = self.connection().call(INSPECT, Symbol(name))
        return text if ok else None

    def interrupt(self) -> None:
        if self.started and self.child.poll() is None:
            self.child.send_signal(signal.SIGINT)
        elif self.conn is not None:
            self.interrupted = True
            self.conn.abort()

    def shutdown(self) -> None:
        if self.conn is not None:
            self.conn.close()
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(3)
            except subprocess.TimeoutExpired:
                self.child.kill()


class Kernel:
    def __init__(self, connection_file: str, backend: Backend):
        with open(connection_file) as f:
            info = json.load(f)
        self.info = info
        self.key = info.get("key", "").encode()
        scheme = info.get("signature_scheme", "hmac-sha256")
        self.digest = getattr(hashlib, scheme.split("-", 1)[1]) if self.key else None
        self.session = uuid.uuid4().hex
        self.backend = backend
        self.count = 0
        self.context = zmq.Context.instance()
        self.iopub = self.context.socket(zmq.PUB)
        self.iopub.bind(self.address("iopub_port"))
        self.shell = self.context.socket(zmq.ROUTER)
        self.shell.bind(self.address("shell_port"))
        self.stdin = self.context.socket(zmq.ROUTER)
        self.stdin.bind(self.address("stdin_port"))
        self.iopub_lock = threading.Lock()
        self.exiting = threading.Event()
        threading.Thread(target=self.heartbeat, daemon=True).start()
        threading.Thread(target=self.control, daemon=True).start()

    def address(self, key: str) -> str:
        transport = self.info.get("transport", "tcp")
        ip = self.info.get("ip", "127.0.0.1")
        return f"tcp://{ip}:{self.info[key]}" if transport == "tcp" else f"ipc://{ip}-{self.info[key]}"

    # --- the wire

    def sign(self, frames: list[bytes]) -> bytes:
        if self.digest is None:
            return b""
        h = hmac.new(self.key, digestmod=self.digest)
        for frame in frames:
            h.update(frame)
        return h.hexdigest().encode()

    def receive(self, sock) -> tuple[list[bytes], dict] | None:
        parts = sock.recv_multipart()
        try:
            at = parts.index(DELIMITER)
        except ValueError:
            return None
        idents, signature, frames = parts[:at], parts[at + 1], parts[at + 2 : at + 6]
        if len(frames) < 4 or not hmac.compare_digest(self.sign(frames), signature):
            return None
        header, parent, metadata, content = (json.loads(f) for f in frames)
        return idents, {"header": header, "parent_header": parent, "metadata": metadata, "content": content}

    def send(self, sock, msg_type: str, content: dict, parent: dict | None, idents: list[bytes] | None = None) -> None:
        header = {
            "msg_id": uuid.uuid4().hex,
            "session": self.session,
            "username": "qlint-kernel",
            "date": datetime.now(timezone.utc).isoformat(),
            "msg_type": msg_type,
            "version": PROTOCOL,
        }
        frames = [json.dumps(x, default=str).encode() for x in (header, (parent or {}).get("header", {}), {}, content)]
        sock.send_multipart([*(idents or []), DELIMITER, self.sign(frames), *frames])

    def publish(self, msg_type: str, content: dict, parent: dict | None) -> None:
        with self.iopub_lock:
            self.send(self.iopub, msg_type, content, parent, [f"kernel.{self.session}.{msg_type}".encode()])

    def status(self, state: str, parent: dict | None) -> None:
        self.publish("status", {"execution_state": state}, parent)

    # --- the channels

    def heartbeat(self) -> None:
        hb = self.context.socket(zmq.REP)
        hb.bind(self.address("hb_port"))
        while True:
            hb.send(hb.recv())

    def control(self) -> None:
        ctl = self.context.socket(zmq.ROUTER)
        ctl.bind(self.address("control_port"))
        while True:
            got = self.receive(ctl)
            if got is None:
                continue
            idents, msg = got
            kind = msg["header"]["msg_type"]
            self.status("busy", msg)
            if kind == "interrupt_request":
                self.backend.interrupt()
                self.send(ctl, "interrupt_reply", {"status": "ok"}, msg, idents)
            elif kind == "shutdown_request":
                self.send(ctl, "shutdown_reply", {"status": "ok", "restart": bool(msg["content"].get("restart"))}, msg, idents)
                self.status("idle", msg)
                self.stop()
            elif kind == "kernel_info_request":
                self.send(ctl, "kernel_info_reply", self.kernel_info(), msg, idents)
            else:
                self.send(ctl, kind.replace("_request", "_reply"), {"status": "error", "ename": "unknown", "evalue": kind, "traceback": []}, msg, idents)
            self.status("idle", msg)

    def stop(self) -> None:
        self.exiting.set()
        self.backend.shutdown()
        # The shell may be waiting on q: the process ends here, not there.
        time.sleep(0.1)
        os._exit(0)

    def serve(self) -> None:
        self.status("starting", None)
        while not self.exiting.is_set():
            got = self.receive(self.shell)
            if got is None:
                continue
            idents, msg = got
            kind = msg["header"]["msg_type"]
            handler = getattr(self, "on_" + kind, None)
            self.status("busy", msg)
            try:
                if handler is None:
                    self.send(self.shell, kind.replace("_request", "_reply"), {"status": "error", "ename": "unknown", "evalue": f"{kind} is not supported", "traceback": []}, msg, idents)
                else:
                    handler(msg, idents)
            finally:
                self.status("idle", msg)

    # --- the requests

    def kernel_info(self) -> dict:
        try:
            version = self.backend.connection().call('string[.z.K]," ",string .z.k')
        except Exception as error:  # noqa: BLE001 - said in the banner
            version = None
            why = str(error)
        banner = f"q-lint kernel {__version__}: q {version} on {self.backend.where}" if version else f"q-lint kernel {__version__}: not connected ({why})"
        if self.backend.started:
            banner += ", started by the kernel"
        return {
            "status": "ok",
            "protocol_version": PROTOCOL,
            "implementation": "qlint_kernel",
            "implementation_version": __version__,
            "language_info": {"name": "q", "version": (version or "").split(" ")[0], "mimetype": "text/x-q", "file_extension": ".q", "pygments_lexer": "q"},
            "banner": banner,
            "help_links": [{"text": "q reference", "url": "https://code.kx.com/q/ref/"}],
        }

    def on_kernel_info_request(self, msg, idents) -> None:
        self.send(self.shell, "kernel_info_reply", self.kernel_info(), msg, idents)

    def on_execute_request(self, msg, idents) -> None:
        content = msg["content"]
        code = content.get("code", "")
        silent = bool(content.get("silent"))
        if content.get("store_history", True) and not silent:
            self.count += 1
        if not silent:
            self.publish("execute_input", {"code": code, "execution_count": self.count}, msg)
        reply: dict = {"status": "ok", "execution_count": self.count, "user_expressions": {}, "payload": []}
        error: tuple[str, str, list[str]] | None = None
        answer = None
        try:
            answer = self.backend.run(code)
        except Closed as why:
            if self.backend.interrupted:
                error = ("interrupted", "the kernel stopped waiting; the process may still be running the cell, and is reconnected to on the next one", [])
            else:
                error = ("connection", f"the connection to {self.backend.where} closed: {why}", [])
        except QError as why:
            # The lambda itself failed: a process that redefines value or .Q.S.
            error = (str(why), str(why), [])
        except (OSError, ConnectionError) as why:
            error = ("connection", f"could not reach q at {self.backend.where}: {why}", [])
        if not silent:
            for name, text in self.backend.output():
                self.publish("stream", {"name": name, "text": text}, msg)
        if error is None and isinstance(answer, dict):
            if answer.get("ok"):
                if answer.get("type") != NULL_TYPE and not silent:
                    text = answer.get("text")
                    lines = text if isinstance(text, list) else [text or ""]
                    self.publish("execute_result", {"execution_count": self.count, "data": {"text/plain": "\n".join(lines)}, "metadata": {}}, msg)
            else:
                trace = answer.get("trace") or ""
                error = (str(answer.get("error")), str(answer.get("error")), trace.rstrip("\n").split("\n") if trace.strip() else [])
        elif error is None and answer is not None:
            error = ("answer", f"the process answered something other than a query result: {str(answer)[:200]}", [])
        if error is not None:
            ename, evalue, trace = error
            traceback = [f"'{evalue}" if ename == evalue else f"{ename}: {evalue}", *trace]
            if not silent:
                self.publish("error", {"ename": ename, "evalue": evalue, "traceback": traceback}, msg)
            reply = {"status": "error", "execution_count": self.count, "ename": ename, "evalue": evalue, "traceback": traceback}
        self.send(self.shell, "execute_reply", reply, msg, idents)

    def on_complete_request(self, msg, idents) -> None:
        code = msg["content"].get("code", "")
        cursor = msg["content"].get("cursor_pos", len(code))
        m = NAME.search(code[:cursor])
        matches: list[str] = []
        start = cursor
        if m is not None:
            start = m.start()
            try:
                matches = self.backend.complete(m.group(0))
            except Exception:  # noqa: BLE001 - no completions, rather than an error
                matches = []
        self.send(self.shell, "complete_reply", {"status": "ok", "matches": matches, "cursor_start": start, "cursor_end": cursor, "metadata": {}}, msg, idents)

    def on_inspect_request(self, msg, idents) -> None:
        code = msg["content"].get("code", "")
        cursor = msg["content"].get("cursor_pos", len(code))
        before = NAME.search(code[:cursor])
        after = NAME_AFTER.match(code[cursor:])
        name = (before.group(0) if before else "") + (after.group(0) if after else "")
        text = None
        if name:
            try:
                text = self.backend.inspect(name)
            except Exception:  # noqa: BLE001 - nothing found
                text = None
        content = {"status": "ok", "found": text is not None, "data": {"text/plain": f"{name}: {text}"} if text is not None else {}, "metadata": {}}
        self.send(self.shell, "inspect_reply", content, msg, idents)

    def on_is_complete_request(self, msg, idents) -> None:
        status, indent = is_complete(msg["content"].get("code", ""))
        self.send(self.shell, "is_complete_reply", {"status": status, **({"indent": indent} if status == "incomplete" else {})}, msg, idents)

    def on_history_request(self, msg, idents) -> None:
        self.send(self.shell, "history_reply", {"status": "ok", "history": []}, msg, idents)

    def on_comm_info_request(self, msg, idents) -> None:
        self.send(self.shell, "comm_info_reply", {"status": "ok", "comms": {}}, msg, idents)

    def on_shutdown_request(self, msg, idents) -> None:
        self.send(self.shell, "shutdown_reply", {"status": "ok", "restart": bool(msg["content"].get("restart"))}, msg, idents)
        self.status("idle", msg)
        self.stop()


def run(connection_file: str, connect: str | None, q: list[str] | None, user: str | None, console_size: tuple[int, int]) -> None:
    backend = Backend(connect, q, user, console_size)
    kernel = Kernel(connection_file, backend)
    for sig in (signal.SIGTERM,):
        signal.signal(sig, lambda *_: kernel.stop())
    # Interrupts come as messages; a SIGINT sent to the kernel's group is ignored.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        kernel.serve()
    finally:
        backend.shutdown()
    sys.exit(0)
