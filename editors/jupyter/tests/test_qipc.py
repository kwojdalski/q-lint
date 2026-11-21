"""The kernel's pieces that need neither ZeroMQ nor Jupyter: the statement
cutter, is_complete, the IPC codec and decompression, and the kernel spec
``install`` writes. With QLINT_TEST_Q, the codec against a real q.

    python -m unittest discover -s editors/jupyter/tests
"""

from __future__ import annotations

import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qlint_kernel import __main__ as cli  # noqa: E402
from qlint_kernel.qipc import Closed, QConnection, QError, Symbol, deserialize, message, serialize, uncompress  # noqa: E402
from qlint_kernel.statements import is_complete, statements  # noqa: E402

Q = os.environ.get("QLINT_TEST_Q")


def q_command() -> tuple[list[str], dict]:
    """QLINT_TEST_Q - a command line, `env A=B q` allowed - as argv and env."""
    words = shlex.split(Q or "")
    env = dict(os.environ)
    if words[:1] == ["env"]:
        words = words[1:]
    while len(words) > 1 and "=" in words[0] and not words[0].startswith("-"):
        key, _, value = words.pop(0).partition("=")
        env[key] = value
    return words, env


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_q(port: int, script: str | None = None) -> subprocess.Popen:
    argv, env = q_command()
    child = subprocess.Popen([*argv, *([script] if script else []), "-q", "-p", f"127.0.0.1:{port}"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(150):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return child
        except OSError:
            time.sleep(0.1)
    child.kill()
    raise RuntimeError("q did not listen")


class Statements(unittest.TestCase):
    def test_cut_as_q_reads_a_script(self):
        self.assertEqual(statements("a:1\nb:a+1"), ["a:1", "b:a+1"])
        self.assertEqual(statements("f:{x+\n  y}\n/ comment\nf[1;2]"), ["f:{x+\n  y}", "f[1;2]"])
        self.assertEqual(statements("/\nblock\n\\\nx\n\\\nafter the end"), ["x"])
        self.assertEqual(statements("#!/usr/bin/q\n  1"), ["1"])
        self.assertEqual(statements("a:1\n/ c\n  +1"), ["a:1\n  +1"])
        self.assertEqual(statements("\n \n/ only comments\n"), [])

    def test_is_complete_while_a_bracket_is_open(self):
        self.assertEqual(is_complete("1+1"), ("complete", ""))
        self.assertEqual(is_complete("f:{x+"), ("incomplete", " "))
        self.assertEqual(is_complete('s:"{"'), ("complete", ""))
        self.assertEqual(is_complete('s:"abc'), ("incomplete", " "))
        self.assertEqual(is_complete("a:1 / {"), ("complete", ""))
        self.assertEqual(is_complete("f:{x)"), ("invalid", ""))


class Codec(unittest.TestCase):
    def test_round_trip_of_what_the_kernel_sends(self):
        msg = message(["{x}", ["a", "`b"], [1.0, 2.0], Symbol("s")])
        self.assertEqual(msg[:2], b"\x01\x01")
        self.assertEqual(int.from_bytes(msg[4:8], "little"), len(msg))
        self.assertEqual(deserialize(msg), ["{x}", ["a", "`b"], [1.0, 2.0], Symbol("s")])
        self.assertEqual(deserialize(b"\x01\x02\x00\x00" + (8 + len(serialize(None))).to_bytes(4, "little") + serialize(None)), None)
        with self.assertRaises(QError) as caught:
            deserialize(b"\x01\x02\x00\x00\x0f\x00\x00\x00\x80type\x00")
        self.assertEqual(str(caught.exception), "type")
        with self.assertRaises(TypeError):
            serialize(object())


@unittest.skipUnless(Q, "QLINT_TEST_Q names no q binary")
class RealQ(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.q = start_q(cls.port)
        cls.c = QConnection("127.0.0.1", cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.c.close()
        cls.q.kill()
        cls.q.wait()

    def test_values_q_answers(self):
        c = self.c
        self.assertEqual(c.call("1+1"), 2)
        self.assertEqual(c.call("{x+y}", 1, 2), 3)
        self.assertEqual(c.call("`a`b!1 2"), {"a": 1, "b": 2})
        self.assertEqual(c.call("([]a:1 2;b:`x`y)"), ("table", {"a": [1, 2], "b": [Symbol("x"), Symbol("y")]}))
        self.assertEqual(c.call('("ab";`c;1.5;0b;0x0f;2024.01.02)'), ["ab", Symbol("c"), 1.5, False, 15, 8767])
        self.assertEqual(c.call("{x}"), c.call("{x}"))  # a function, read as one
        with self.assertRaises(QError) as caught:
            c.call("1+`a")
        self.assertEqual(str(caught.exception), "type")

    def test_a_compressed_message_is_read(self):
        # -18! writes a value as q compresses it for the wire.
        data = bytes(self.c.call("-18!til 10000"))
        self.assertEqual(data[2], 1)
        self.assertEqual(deserialize(data), list(range(10000)))
        self.assertEqual(uncompress(data)[8:], bytes(self.c.call("-8!til 10000"))[8:])

    def test_abort_stops_the_wait(self):
        c = QConnection("127.0.0.1", self.port)
        import threading

        threading.Timer(0.3, c.abort).start()
        start = time.monotonic()
        with self.assertRaises(Closed):
            c.call('system "sleep 1"')
        self.assertLess(time.monotonic() - start, 0.9)
        self.assertFalse(c.is_open)
        time.sleep(1)


class Install(unittest.TestCase):
    def test_the_spec_and_never_overwriting_one(self):
        with tempfile.TemporaryDirectory() as prefix:
            self.assertEqual(cli.install(["--prefix", prefix, "--q", "q -s 2", "--env", "QHOME=/opt/q"]), 0)
            spec = json.loads((Path(prefix) / "share/jupyter/kernels/q-lint/kernel.json").read_text())
            self.assertEqual(spec["argv"][1:], ["-m", "qlint_kernel", "-f", "{connection_file}", "--q", "q -s 2", "--console-size", "100", "200"])
            self.assertEqual(spec["language"], "q")
            self.assertEqual(spec["interrupt_mode"], "message")
            self.assertEqual(spec["env"], {"QHOME": "/opt/q"})
            # The same again is fine; another is refused without --replace.
            self.assertEqual(cli.install(["--prefix", prefix, "--q", "q -s 2", "--env", "QHOME=/opt/q"]), 0)
            self.assertEqual(cli.install(["--prefix", prefix, "--connect", "localhost:5001"]), 1)
            self.assertIn("--q", json.loads((Path(prefix) / "share/jupyter/kernels/q-lint/kernel.json").read_text())["argv"])
            self.assertEqual(cli.install(["--prefix", prefix, "--connect", "localhost:5001", "--replace"]), 0)
            self.assertIn("--connect", json.loads((Path(prefix) / "share/jupyter/kernels/q-lint/kernel.json").read_text())["argv"])


if __name__ == "__main__":
    unittest.main()
