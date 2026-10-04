"""Findings must not depend on things that do not change what q runs.

    python3 scripts/check_invariance.py target/release/qlinter ~/q-corpus

Each file of the corpus is rewritten three ways that leave its meaning alone,
and the findings compared with the original's:

- line endings: LF and CRLF give the same findings at the same positions;
- position: a blank line prepended moves every finding down exactly one line;
- comments: a trailing ` / note` on plain code lines changes nothing.

Every difference is a bug in the linter. The comment check found one the
day it was written: an empty `$[...]` slot was judged on the raw source, so a
comment in it filled it and moved a finding.
"""

import collections
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def lint(binary, paths):
    out = subprocess.run(
        [binary, "--profile", "uqf", "--format", "json", *map(str, paths)],
        capture_output=True,
        text=True,
    ).stdout
    found = collections.defaultdict(set)
    for f in json.loads(out or "[]"):
        found[Path(f["path"]).name].add((f["line"], f["column"], f["code"]))
    return found


def commented(text):
    """A trailing comment on lines where one cannot change the program:
    outside block comments and strings, not a system command or another
    language's line, and not already ending in a slash or a comment."""
    out, block, ended, in_string = [], False, False, False
    for line in text.split("\n"):
        stripped = line.strip()
        if ended:
            out.append(line)
            continue
        if not block and not in_string and stripped == "\\":
            ended = True
        elif not in_string and stripped == "/":
            block = True
        elif block:
            block = stripped != "\\"
        elif (
            in_string
            or '"' in line
            or not stripped
            or line.startswith(("\\", "/"))
            or re.match(r"^\s*/|^[a-z]\)", line)
            or line.rstrip().endswith("/")
            or re.search(r"\s/", line)
        ):
            if (line.count('"') - line.count('\\"')) % 2:
                in_string = not in_string
        else:
            out.append(line.rstrip("\r") + " / note" + ("\r" if line.endswith("\r") else ""))
            continue
        out.append(line)
    return "\n".join(out)


def main() -> int:
    binary, corpus = sys.argv[1], Path(sys.argv[2]).expanduser()
    sources = sorted(corpus.rglob("*.q"))
    with tempfile.TemporaryDirectory() as tmp:
        dirs = {k: Path(tmp, k) for k in ("lf", "crlf", "shift", "comment")}
        for d in dirs.values():
            d.mkdir()
        for i, path in enumerate(sources):
            text = path.read_bytes().decode("utf-8", "replace").replace("\r\n", "\n")
            name = f"{i}.q"
            (dirs["lf"] / name).write_text(text)
            (dirs["crlf"] / name).write_text(text.replace("\n", "\r\n"))
            (dirs["shift"] / name).write_text("\n" + text)
            (dirs["comment"] / name).write_text(commented(text))
        names = [f"{i}.q" for i in range(len(sources))]
        got = {k: lint(binary, [d / n for n in names]) for k, d in dirs.items()}
    base = got["lf"]
    failures = 0
    for kind, expect in [
        ("crlf", lambda s: s),
        ("shift", lambda s: {(line + 1, col, code) for line, col, code in s}),
        ("comment", lambda s: s),
    ]:
        bad = [n for n in names if expect(base[n]) != got[kind][n]]
        failures += len(bad)
        print(f"{kind:8} {len(bad)} of {len(names)} files differ")
        for n in bad[:5]:
            print(f"    {sources[int(n[:-2])]}: {sorted(expect(base[n]) ^ got[kind][n])[:3]}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
