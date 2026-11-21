"""One connection to a q process over its IPC protocol, in the standard library.

The protocol (code.kx.com/q/basics/ipc): the client sends ``user:password``,
a capability byte and a NUL; the process answers one byte, or closes the
socket to refuse. Each message after that has an 8-byte header - byte 0 the
byte order (1, little-endian), byte 1 the type (0 async, 1 sync, 2
response), byte 2 whether the body is compressed, bytes 4-7 the whole
length - and a body.

The kernel sends char vectors, general lists, float vectors and symbols, and
reads back whatever q answers: atoms, vectors, general lists, dictionaries,
tables and errors. A temporal value is read as its number in q's own unit
(days, milliseconds or nanoseconds from 2000.01.01, or since midnight); the
kernel never shows one itself, since q formats the result text.
"""

from __future__ import annotations

import socket
import struct
import threading
from dataclasses import dataclass

CAPABILITY = 3
SYNC = 1
RESPONSE = 2


class QError(Exception):
    """The process answered with an error (``'msg``): the query ran."""


class Closed(Exception):
    """The connection closed, or was closed, before an answer came."""


@dataclass(frozen=True)
class Symbol:
    """A q symbol, as against a string, which q reads as a char vector."""

    name: str


@dataclass(frozen=True)
class Function:
    """A q function or other value with no Python counterpart: its q type."""

    qtype: int


# Fixed-width vector types: q type -> struct code, element size.
_FIXED = {
    1: ("?", 1),  # boolean
    4: ("B", 1),  # byte
    5: ("h", 2),  # short
    6: ("i", 4),  # int
    7: ("q", 8),  # long
    8: ("f", 4),  # real
    9: ("d", 8),  # float
    12: ("q", 8),  # timestamp
    13: ("i", 4),  # month
    14: ("i", 4),  # date
    15: ("d", 8),  # datetime
    16: ("q", 8),  # timespan
    17: ("i", 4),  # minute
    18: ("i", 4),  # second
    19: ("i", 4),  # time
}


def serialize(value: object) -> bytes:
    """``value`` as a q object's bytes: str is a char vector, Symbol a symbol,
    a list or tuple a general list - unless every item is a float, which is a
    float vector - bool a boolean, int a long, float a float, None ``::``."""
    if isinstance(value, Symbol):
        return b"\xf5" + value.name.encode() + b"\x00"
    if isinstance(value, str):
        data = value.encode()
        return struct.pack("<bBi", 10, 0, len(data)) + data
    if isinstance(value, bool):
        return struct.pack("<b?", -1, value)
    if isinstance(value, int):
        return struct.pack("<bq", -7, value)
    if isinstance(value, float):
        return struct.pack("<bd", -9, value)
    if value is None:
        return b"\x65\x00"
    if isinstance(value, (list, tuple)):
        if value and all(isinstance(v, float) for v in value):
            return struct.pack("<bBi", 9, 0, len(value)) + struct.pack(f"<{len(value)}d", *value)
        return struct.pack("<bBi", 0, 0, len(value)) + b"".join(serialize(v) for v in value)
    raise TypeError(f"cannot send a {type(value).__name__} to q")


def message(value: object, kind: int = SYNC) -> bytes:
    body = serialize(value)
    return struct.pack("<BBBBI", 1, kind, 0, 0, 8 + len(body)) + body


def uncompress(data: bytes) -> bytes:
    """A compressed message, header and all, as the message it compresses:
    q's own algorithm, as KX's Java client has it."""
    size = struct.unpack_from("<i", data, 8)[0]
    dst = bytearray(size)
    dst[0:8] = data[0:8]
    dst[2] = 0
    struct.pack_into("<I", dst, 4, size)
    recent = [0] * 256
    d = 12
    s = 8
    p = 8
    i = 0
    f = 0
    while s < size:
        if i == 0:
            f = data[d]
            d += 1
            i = 1
        n = 0
        if f & i:
            r = recent[data[d]]
            d += 1
            dst[s] = dst[r]
            dst[s + 1] = dst[r + 1]
            s += 2
            r += 2
            n = data[d]
            d += 1
            for m in range(n):
                dst[s + m] = dst[r + m]
        else:
            dst[s] = data[d]
            s += 1
            d += 1
        while p < s - 1:
            recent[dst[p] ^ dst[p + 1]] = p
            p += 1
        if f & i:
            s += n
            p = s
        i *= 2
        if i == 256:
            i = 0
    return bytes(dst)


class _Reader:
    def __init__(self, data: bytes, at: int = 8):
        self.data = data
        self.at = at

    def take(self, fmt: str):
        values = struct.unpack_from("<" + fmt, self.data, self.at)
        self.at += struct.calcsize("<" + fmt)
        return values[0] if len(values) == 1 else values

    def symbol(self) -> str:
        end = self.data.index(b"\x00", self.at)
        name = self.data[self.at : end].decode("utf-8", "replace")
        self.at = end + 1
        return name

    def read(self):
        t = self.take("b")
        if t == -128:
            raise QError(self.symbol())
        if t < 0:
            if t == -10:
                self.at += 1
                return self.data[self.at - 1 : self.at].decode("latin-1")
            if t == -11:
                return Symbol(self.symbol())
            if t == -2:
                self.at += 16
                return Function(-2)
            code, _size = _FIXED[-t]
            return self.take(code)
        if t == 0 or 1 <= t <= 19:
            self.take("B")  # attribute
            n = self.take("i")
            if t == 0:
                return [self.read() for _ in range(n)]
            if t == 10:
                text = self.data[self.at : self.at + n].decode("utf-8", "replace")
                self.at += n
                return text
            if t == 11:
                return [Symbol(self.symbol()) for _ in range(n)]
            if t == 2:
                self.at += 16 * n
                return [Function(-2)] * n
            code, size = _FIXED[t]
            values = list(struct.unpack_from(f"<{n}{code}", self.data, self.at))
            self.at += size * n
            return values
        if t == 98:
            self.take("B")
            return ("table", self.read())
        if t in (99, 127):
            keys = self.read()
            values = self.read()
            if isinstance(keys, list) and all(isinstance(k, Symbol) for k in keys) and isinstance(values, list):
                return {k.name: v for k, v in zip(keys, values)}
            return ("dict", keys, values)
        if t == 101:
            self.take("B")
            return None
        # A lambda, a projection, a composition or another function: its
        # body is not read, and nothing after it can be either.
        self.at = len(self.data)
        return Function(t)


def deserialize(data: bytes):
    """A whole message, header and all, as Python values; raises QError for
    an error."""
    if data[2] == 1:
        data = uncompress(data)
    return _Reader(data).read()


class QConnection:
    """A connection that runs one query at a time. ``abort`` from another
    thread stops the wait at once: the call raises ``Closed``."""

    def __init__(self, host: str, port: int, user: str | None = None, password: str | None = None, timeout: float = 10.0):
        self.host = host
        self.port = port
        sock = socket.create_connection((host, port), timeout=timeout)
        try:
            auth = f"{user}:{password or ''}" if user else ""
            sock.sendall(auth.encode() + bytes([CAPABILITY, 0]))
            answer = sock.recv(1)
        except OSError:
            sock.close()
            raise
        if not answer:
            sock.close()
            raise ConnectionRefusedError(f"{host}:{port} closed the connection: the user or password was refused")
        sock.settimeout(None)
        self._sock = sock
        self._lock = threading.Lock()
        self._closed = False

    @property
    def is_open(self) -> bool:
        return not self._closed

    def _recv(self, n: int) -> bytes:
        chunks = []
        while n > 0:
            chunk = self._sock.recv(min(n, 1 << 20))
            if not chunk:
                raise Closed(f"{self.host}:{self.port} closed the connection")
            chunks.append(chunk)
            n -= len(chunk)
        return b"".join(chunks)

    def call(self, *values: object):
        """Send ``values`` as one sync message - a lambda's text and its
        arguments, or one string of q - and read the answer."""
        payload = values[0] if len(values) == 1 else list(values)
        with self._lock:
            try:
                self._sock.sendall(message(payload))
                while True:
                    header = self._recv(8)
                    size = struct.unpack_from("<I", header, 4)[0]
                    data = header + self._recv(size - 8)
                    if data[1] == RESPONSE:
                        return deserialize(data)
                    if data[1] == SYNC:
                        # The process asked us something: refuse, as q-lint does.
                        text = b"qlint-kernel answers no sync request"
                        self._sock.sendall(struct.pack("<BBBBIb", 1, RESPONSE, 0, 0, 10 + len(text), -128) + text + b"\x00")
            except OSError as error:
                self._closed = True
                raise Closed(str(error)) from error
            except Closed:
                self._closed = True
                raise

    def abort(self) -> None:
        """Stop waiting: close the socket under a call in progress."""
        self._closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._sock.close()

    close = abort
