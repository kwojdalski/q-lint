"""The kernel through Jupyter's own client, against a real q (QLINT_TEST_Q):
a kernel that starts its own q, and one that connects to a q started here.
Needs pyzmq and jupyter_client:

    QLINT_TEST_Q=q uv run --with pyzmq --with jupyter_client \\
        python -m unittest discover -s editors/jupyter/tests
"""

from __future__ import annotations

import json
import os
import shlex
import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_qipc import Q, free_port, q_command, start_q  # noqa: E402

try:
    from jupyter_client.manager import start_new_kernel
except ImportError:  # pragma: no cover - said in the skip
    start_new_kernel = None

TIMEOUT = 30


def spec(folder: Path, name: str, *options: str) -> None:
    """A kernel spec `name` under `folder`, running this tree's kernel."""
    argv, env = q_command()
    kernel_env = {k: v for k, v in env.items() if k in ("QHOME", "QLIC", "QINIT")}
    kernel_env["PYTHONPATH"] = str(HERE)
    target = folder / "kernels" / name
    target.mkdir(parents=True)
    (target / "kernel.json").write_text(
        json.dumps(
            {
                "argv": [sys.executable, "-m", "qlint_kernel", "-f", "{connection_file}", *options],
                "display_name": name,
                "language": "q",
                "interrupt_mode": "message",
                "env": kernel_env,
            }
        )
    )


def run(kc, code: str, timeout: float = TIMEOUT) -> tuple[dict, list[dict]]:
    """Execute `code`: the reply's content and the IOPub messages for it."""
    msg_id = kc.execute(code)
    published = []
    while True:
        msg = kc.get_iopub_msg(timeout=timeout)
        if msg["parent_header"].get("msg_id") != msg_id:
            continue
        published.append(msg)
        if msg["msg_type"] == "status" and msg["content"]["execution_state"] == "idle":
            break
    reply = kc.get_shell_msg(timeout=timeout)
    while reply["parent_header"].get("msg_id") != msg_id:
        reply = kc.get_shell_msg(timeout=timeout)
    return reply["content"], published


def results(published: list[dict]) -> list[str]:
    return [m["content"]["data"]["text/plain"] for m in published if m["msg_type"] == "execute_result"]


def streams(published: list[dict]) -> str:
    return "".join(m["content"]["text"] for m in published if m["msg_type"] == "stream")


def accepts(port: int) -> bool:
    try:
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
        return True
    except OSError:
        return False


@unittest.skipUnless(Q and start_new_kernel, "needs QLINT_TEST_Q and jupyter_client")
class StartedQ(unittest.TestCase):
    """A kernel that starts its own q, as installing it with --q sets up."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        argv, _env = q_command()
        spec(Path(cls.tmp.name), "qlint-test", "--q", shlex.join(argv), "--console-size", "20", "80")
        os.environ["JUPYTER_PATH"] = cls.tmp.name
        cls.km, cls.kc = start_new_kernel(kernel_name="qlint-test", startup_timeout=TIMEOUT)

    @classmethod
    def tearDownClass(cls):
        cls.kc.stop_channels()
        cls.km.shutdown_kernel(now=False)
        cls.tmp.cleanup()

    def test_kernel_info_says_q(self):
        self.kc.kernel_info()
        reply = self.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        self.assertEqual(reply["language_info"]["name"], "q")
        self.assertEqual(reply["language_info"]["file_extension"], ".q")
        self.assertRegex(reply["banner"], r"q-lint kernel .*: q \d.* on 127\.0\.0\.1:\d+, started by the kernel")

    def test_results_errors_and_output(self):
        reply, published = run(self.kc, "1+1")
        self.assertEqual(reply["status"], "ok")
        self.assertEqual(results(published), ["2"])
        self.assertTrue(any(m["msg_type"] == "execute_input" for m in published))
        # An assignment ending in ; shows nothing; statements and continuation lines as in a script.
        reply, published = run(self.kc, "a:til 3;\nf:{x+\n  y}\n/ a comment\nf[a;10]")
        self.assertEqual(results(published), ["10 11 12"])
        reply, published = run(self.kc, "a:5;")
        self.assertEqual(results(published), [])
        # An error, with its message.
        reply, published = run(self.kc, "1+`a")
        self.assertEqual(reply["status"], "error")
        self.assertEqual(reply["ename"], "type")
        self.assertEqual([m["content"]["ename"] for m in published if m["msg_type"] == "error"], ["type"])
        # What q writes to stdout and stderr, in order, before the result.
        reply, published = run(self.kc, '-1 "hello";-2 "oops";-1 "again";42')
        self.assertEqual(results(published), ["42"])
        self.assertEqual([m["content"]["name"] for m in published if m["msg_type"] == "stream"][:1], ["stdout"])
        self.assertIn("hello\n", streams(published))
        self.assertIn("again\n", streams(published))
        self.assertIn("oops\n", streams(published))
        # A large result is cut at the console size.
        reply, published = run(self.kc, "til 100000")
        self.assertLessEqual(len(results(published)[0]), 80)
        # A table, formatted by q.
        reply, published = run(self.kc, "([]a:1 2;b:`x`y)")
        self.assertEqual(results(published), ["a b\n---\n1 x\n2 y"])

    def test_complete_inspect_and_is_complete(self):
        run(self.kc, "myvar:42;")
        _reply, published = run(self.kc, "(system \"v\";system \"f\";key `)")
        names = results(published)
        self.kc.complete("1+myv", 5)
        reply = self.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        self.assertEqual((reply["matches"], reply["cursor_start"], reply["cursor_end"]), (["myvar"], 2, 5))
        self.kc.complete("ti", 2)
        self.assertIn("til", self.kc.get_shell_msg(timeout=TIMEOUT)["content"]["matches"])
        self.kc.complete(".Q.ad", 5)
        matches = self.kc.get_shell_msg(timeout=TIMEOUT)["content"]["matches"]
        self.assertTrue(matches and all(m.startswith(".Q.ad") for m in matches), matches)
        self.kc.inspect("myvar", 2)
        reply = self.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        self.assertTrue(reply["found"])
        self.assertEqual(reply["data"]["text/plain"], "myvar: 42")
        self.kc.inspect("nosuchname", 3)
        self.assertFalse(self.kc.get_shell_msg(timeout=TIMEOUT)["content"]["found"])
        self.kc.is_complete("f:{x+")
        self.assertEqual(self.kc.get_shell_msg(timeout=TIMEOUT)["content"], {"status": "incomplete", "indent": " "})
        # Completion and inspection define nothing.
        _reply, published = run(self.kc, "(system \"v\";system \"f\";key `)")
        self.assertEqual(results(published), names)

    def test_interrupt_stops_a_long_cell(self):
        msg_id = self.kc.execute("{r:0; do[2000000000; r+:1]; r}[]")
        time.sleep(1)
        self.km.interrupt_kernel()
        reply = self.kc.get_shell_msg(timeout=TIMEOUT)
        while reply["parent_header"].get("msg_id") != msg_id:
            reply = self.kc.get_shell_msg(timeout=TIMEOUT)
        self.assertEqual(reply["content"]["status"], "error")
        self.assertEqual(reply["content"]["ename"], "stop")
        _reply, published = run(self.kc, "2+2")
        self.assertEqual(results(published), ["4"])


@unittest.skipUnless(Q and start_new_kernel, "needs QLINT_TEST_Q and jupyter_client")
class ConnectedQ(unittest.TestCase):
    """A kernel that connects to a q it did not start, as --connect sets up."""

    def test_runs_on_the_process_interrupt_stops_waiting_and_restart_and_shutdown_leave_it(self):
        port = free_port()
        q = start_q(port)
        tmp = tempfile.TemporaryDirectory()
        try:
            spec(Path(tmp.name), "qlint-connect", "--connect", f"127.0.0.1:{port}")
            os.environ["JUPYTER_PATH"] = tmp.name
            km, kc = start_new_kernel(kernel_name="qlint-connect", startup_timeout=TIMEOUT)
            try:
                _reply, published = run(kc, "kept:7;kept*6")
                self.assertEqual(results(published), ["42"])
                # Interrupted, the kernel stops waiting; the next cell reconnects.
                msg_id = kc.execute('system "sleep 2"')
                time.sleep(0.5)
                km.interrupt_kernel()
                reply = kc.get_shell_msg(timeout=TIMEOUT)
                while reply["parent_header"].get("msg_id") != msg_id:
                    reply = kc.get_shell_msg(timeout=TIMEOUT)
                self.assertEqual(reply["content"]["ename"], "interrupted")
                _reply, published = run(kc, "kept")
                self.assertEqual(results(published), ["7"])
                # A restart is a new kernel on the same process: its state stays.
                km.restart_kernel(now=False)
                kc.wait_for_ready(timeout=TIMEOUT)
                _reply, published = run(kc, "kept")
                self.assertEqual(results(published), ["7"])
            finally:
                kc.stop_channels()
                km.shutdown_kernel(now=False)
            # The process the kernel did not start is left running.
            self.assertIsNone(q.poll())
            self.assertTrue(accepts(port))
        finally:
            q.kill()
            q.wait()
            tmp.cleanup()


@unittest.skipUnless(Q and start_new_kernel, "needs QLINT_TEST_Q and jupyter_client")
class Lifetime(unittest.TestCase):
    def test_restart_starts_a_new_q_and_shutdown_stops_it(self):
        tmp = tempfile.TemporaryDirectory()
        argv, _env = q_command()
        spec(Path(tmp.name), "qlint-life", "--q", shlex.join(argv))
        os.environ["JUPYTER_PATH"] = tmp.name
        km, kc = start_new_kernel(kernel_name="qlint-life", startup_timeout=TIMEOUT)
        try:
            run(kc, "x:1;")
            _reply, published = run(kc, "system \"p\"")
            first = int(results(published)[0].rstrip("i"))
            km.restart_kernel(now=False)
            kc.wait_for_ready(timeout=TIMEOUT)
            reply, published = run(kc, "x")
            self.assertEqual(reply["status"], "error")
            self.assertEqual(reply["ename"], "x")
            # The first q ended with its kernel.
            for _ in range(50):
                if not accepts(first):
                    break
                time.sleep(0.1)
            self.assertFalse(accepts(first))
            _reply, published = run(kc, "system \"p\"")
            second = int(results(published)[0].rstrip("i"))
        finally:
            kc.stop_channels()
            km.shutdown_kernel(now=False)
            tmp.cleanup()
        for _ in range(50):
            if not accepts(second):
                break
            time.sleep(0.1)
        self.assertFalse(accepts(second))


if __name__ == "__main__":
    unittest.main()
