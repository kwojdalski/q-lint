"""Findings must not depend on things that do not change what q runs.

    python3 scripts/check_invariance.py target/release/qlinter ~/q-corpus
    python3 scripts/check_invariance.py target/release/qlinter examples tests/corpus tests/cases

Each source is rewritten three ways that leave its meaning alone, and the
findings compared with the original's. A source is a `.q` file, found under a
directory or named outright, linted under the `uqf` profile; or one case of a
`tests/cases/*.cases` file, linted under the profile its header names - which
is how CI runs it over the q in this tree without the external corpus.

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


# How each profile a case can name is asked for on the command line: `every`
# is every rule, which `--select Q` is, since every code starts with Q.
PROFILES = {
    "uqf": ["--profile", "uqf"],
    "style": ["--profile", "style"],
    "styleq": ["--profile", "styleq"],
    "general": ["--profile", "general"],
    "every": ["--select", "Q"],
}


def lint(binary, paths, profile="uqf"):
    out = subprocess.run(
        [binary, *PROFILES[profile], "--format", "json", *map(str, paths)],
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


def cases(path):
    """Each case of a `.cases` file as (label, profile, source), split and
    trimmed as `tests/cases.rs` does."""
    found = []
    for i, line in enumerate(path.read_text().split("\n")):
        if line.startswith("=== "):
            codes = line[4:].split("|")[0].split()
            profile = codes[codes.index("profile:") + 1] if "profile:" in codes else "style"
            found.append([f"{path}:{i + 1}", profile if profile in PROFILES else "style", []])
        elif found:
            found[-1][2].append(line)
    return [(label, profile, "\n".join(body).strip("\n")) for label, profile, body in found]


def sources(roots):
    """(label, profile, text) for every `.q` file and every case under
    `roots`, each a directory or a file."""
    found = []
    for root in map(lambda r: Path(r).expanduser(), roots):
        files = sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else [root]
        for path in files:
            if path.suffix == ".q":
                text = path.read_bytes().decode("utf-8", "replace")
                found.append((str(path), "uqf", text))
            elif path.suffix == ".cases":
                found.extend(cases(path))
    return found


def main() -> int:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    binary, found = sys.argv[1], sources(sys.argv[2:])
    if not found:
        sys.exit(f"no .q file or case under {' '.join(sys.argv[2:])}")
    with tempfile.TemporaryDirectory() as tmp:
        dirs = {k: Path(tmp, k) for k in ("lf", "crlf", "shift", "comment")}
        for d in dirs.values():
            d.mkdir()
        for i, (_, _, text) in enumerate(found):
            text = text.replace("\r\n", "\n")
            name = f"{i}.q"
            (dirs["lf"] / name).write_text(text)
            (dirs["crlf"] / name).write_text(text.replace("\n", "\r\n"))
            (dirs["shift"] / name).write_text("\n" + text)
            (dirs["comment"] / name).write_text(commented(text))
        names = [f"{i}.q" for i in range(len(found))]
        got = {}
        for k, d in dirs.items():
            got[k] = collections.defaultdict(set)
            for profile in {p for _, p, _ in found}:
                chosen = [d / n for n, (_, p, _) in zip(names, found) if p == profile]
                got[k].update(lint(binary, chosen, profile))
    base = got["lf"]
    failures = 0
    # A byte-order mark or a `#!` line means something only at the very
    # start of a file, so a blank line before it changes the program: q skips
    # `#!` on line 1 alone. Those are left out of the position check.
    anchored = {n for n, (_, _, text) in zip(names, found) if text.startswith(("\ufeff", "#!"))}
    for kind, expect, checked in [
        ("crlf", lambda s: s, names),
        ("shift", lambda s: {(line + 1, col, code) for line, col, code in s},
         [n for n in names if n not in anchored]),
        ("comment", lambda s: s, names),
    ]:
        bad = [n for n in checked if expect(base[n]) != got[kind][n]]
        failures += len(bad)
        print(f"{kind:8} {len(bad)} of {len(checked)} files differ")
        for n in bad[:5]:
            print(f"    {found[int(n[:-2])][0]}: {sorted(expect(base[n]) ^ got[kind][n])[:3]}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
