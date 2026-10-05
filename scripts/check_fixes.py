"""Every --fix rewrite has to compile to the program it replaced.

    python3 scripts/check_fixes.py target/release/qlinter ~/q-corpus
    python3 scripts/check_fixes.py --unsafe target/release/qlinter ~/q-corpus

Copies the corpus, applies `--fix --profile uqf`, splits both versions into
top-level statements, and asks q to `parse` each changed pair. `parse` reads
q without running it. Two statements are the same program when their parse
trees match, with each lambda compared by what it compiles to - bytecode,
parameters, locals, globals, constants - and not by its source text or the
positions q keeps for error messages, which a rewrite changes by design.

The first run found four rewrites that were wrong: `f g::` and `f X@\\:` are
compositions, not calls, and `stop f/x` is the while form of over, whose
bracketed rewrite does not parse. Requires `q` on PATH.

With --unsafe the editor-only fixes are applied too. Those may change the
program by design, so a `changed` verdict is expected there; `broken` - a
rewrite q cannot parse - is still a failure.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

COMPARE = r"""
p:.j.k raze read0 hsym`$getenv`PAIRS;
norm:{$[100h=type x; .z.s each v where not (type each v:value x) in 7 10h; 0h=type x; .z.s each x; x]};
r:{[x] a:@[parse;x 0;{`ERR}]; b:@[parse;x 1;{`ERR}];
  $[(`ERR~a)&`ERR~b;`unparseable;`ERR~b;`broken;(norm a)~norm b;`same;`changed]} each p;
-1 .j.j r;
exit 0
"""


def statements(text):
    """Top-level statements as q's script loader sees them: a line at the
    left margin starts one, an indented line continues it."""
    out, current, block = [], None, False
    for line in text.split("\n"):
        stripped = line.strip()
        if block:
            block = stripped != "\\"
            continue
        if stripped == "/":
            block = True
            continue
        if not line.startswith((" ", "\t")) and stripped:
            if current is not None:
                out.append(current)
            if stripped == "\\":
                return out
            skip = line.startswith(("/", "\\")) or re.match(r"^[a-z]\)", line)
            current = None if skip else line
        elif current is not None and stripped:
            current += "\n" + line
    if current is not None:
        out.append(current)
    return out


def main() -> int:
    args = sys.argv[1:]
    unsafe = "--unsafe" in args
    args = [a for a in args if a != "--unsafe"]
    binary, corpus = args[0], Path(args[1]).expanduser()
    sources = sorted(corpus.rglob("*.q"))
    pairs = []
    with tempfile.TemporaryDirectory() as tmp:
        copies = []
        for i, path in enumerate(sources):
            copy = Path(tmp, f"{i}.q")
            shutil.copyfile(path, copy)
            copies.append(copy)
        flags = ["--fix", "--unsafe-fixes"] if unsafe else ["--fix"]
        subprocess.run([binary, "--profile", "uqf", *flags, *map(str, copies)], capture_output=True)
        for path, copy in zip(sources, copies):
            before = path.read_bytes().decode("utf-8", "replace").replace("\r\n", "\n")
            after = copy.read_bytes().decode("utf-8", "replace").replace("\r\n", "\n")
            if before == after:
                continue
            a, b = statements(before), statements(after)
            if len(a) != len(b):
                pairs.append((str(path), before, after, "statement count changed"))
                continue
            pairs += [(str(path), x, y, None) for x, y in zip(a, b) if x != y]
        checked = [p for p in pairs if p[3] is None]
        pairs_file = Path(tmp, "pairs.json")
        pairs_file.write_text(json.dumps([[p[1], p[2]] for p in checked]))
        script = Path(tmp, "compare.q")
        script.write_text(COMPARE)
        run = subprocess.run(
            ["q", str(script), "-q"],
            env={**os.environ, "PAIRS": str(pairs_file)},
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
        )
        verdicts = json.loads(run.stdout.strip().splitlines()[-1]) if checked else []
    counts = {v: verdicts.count(v) for v in set(verdicts)}
    print(f"{len(checked)} rewritten statements: {counts}")
    failing = ("broken",) if unsafe else ("changed", "broken")
    bad = [(p, v) for p, v in zip(checked, verdicts) if v in failing]
    bad += [(p, p[3]) for p in pairs if p[3]]
    for (path, before, after, _), verdict in bad[:10]:
        print(f"  {verdict}: {path}")
        for x, y in zip(before.split("\n"), after.split("\n")):
            if x != y:
                print(f"    - {x.strip()[:120]}\n    + {y.strip()[:120]}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
