"""Code from a cell, cut into the statements q would run - the rules of the
VS Code extension's ``statements.ts``, which are q's own for a script.

A query sends q a list of statements, not the text: ``value`` reads one
statement, and a newline inside the string does not end one. A line that
starts with a space or a tab continues the statement above it, a line that
starts with ``/`` is a comment, ``/`` alone opens a block comment that ``\\``
alone closes, and ``\\`` alone outside one ends the script. A first line
starting ``#!`` is skipped, as q skips a script's shebang line.
"""

from __future__ import annotations


def _continues(line: str) -> bool:
    return line.startswith((" ", "\t"))


def statements(text: str) -> list[str]:
    """The statements of ``text``, each with its continuation lines joined
    by newlines."""
    out: list[str] = []
    current: list[str] | None = None
    in_block = False
    for i, raw in enumerate(text.replace("\r\n", "\n").split("\n")):
        line = raw.rstrip()
        if i == 0 and line.startswith("#!"):
            continue
        if in_block:
            if line == "\\":
                in_block = False
            continue
        if line == "/":
            in_block = True
            continue
        if line == "\\":
            break
        if line.strip() == "":
            continue
        if _continues(line) and current is not None:
            current.append(line)
            continue
        if line.startswith("/"):
            continue
        if current is not None:
            out.append("\n".join(current))
        current = [line.lstrip() if _continues(line) else line]
    if current is not None:
        out.append("\n".join(current))
    return out


_OPEN = {"(": ")", "[": "]", "{": "}"}


def is_complete(text: str) -> tuple[str, str]:
    """Whether ``text`` is a whole cell for a console: ``("complete", "")``,
    or ``("incomplete", " ")`` while a bracket is open - a q continuation
    line is indented - or ``("invalid", "")`` for a bracket that closes
    nothing. Strings and comments are skipped."""
    depth: list[str] = []
    for stmt in statements(text):
        in_string = False
        prev = " "
        k = 0
        while k < len(stmt):
            ch = stmt[k]
            if in_string:
                if ch == "\\":
                    k += 1
                elif ch == '"':
                    in_string = False
            elif ch == '"':
                in_string = True
            elif ch == "/" and prev in " \t\n":
                # A comment to the end of the line.
                end = stmt.find("\n", k)
                k = len(stmt) if end < 0 else end
                prev = "\n"
                continue
            elif ch in _OPEN:
                depth.append(_OPEN[ch])
            elif ch in ")]}":
                if not depth or depth.pop() != ch:
                    return ("invalid", "")
            prev = ch
            k += 1
        if in_string:
            return ("incomplete", " ")
    return ("incomplete", " ") if depth else ("complete", "")
