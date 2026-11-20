"""Ask q how many arguments its own functions take, and hold the catalogue to it.

The script q runs is generated here from the names in `src/builtins.json` -
never from anything being linted.
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
Q = shutil.which("q")
CATALOGUE = json.loads((ROOT / "src/builtins.json").read_text())
pytestmark = pytest.mark.skipif(not Q, reason="requires q")

# A name is interpolated into the script, so it is held to a name's letters.
NAME = re.compile(r"\.?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*")

# What q says a value is: a lambda names its parameters, a unary primitive
# takes one argument and an operator two. A projection, a composition or an
# iterator's derived function (104h and up) does not say, so it is not held.
LAMBDA, UNARY, OPERATOR = 100, 101, 102

SCRIPT = """
arity:{[w]
  v:@[{value ".q.",x};w;{`missing}];
  if[v~`missing; v:@[value;w;{`missing}]];
  t:type v;
  n:$[t=100h; count (value v) 1; t=101h; 1; t=102h; 2; -1];
  -1 w,"\\t",(string t),"\\t",string n;};
arity each read0 `:names.txt;
exit 0
"""


def test_a_function_takes_as_many_arguments_as_q_says(tmp_path):
    functions = {b["name"]: b["params"] for b in CATALOGUE if b["kind"] == "function"}
    assert all(NAME.fullmatch(name) for name in functions), sorted(functions)
    (tmp_path / "names.txt").write_text("\n".join(functions) + "\n")
    (tmp_path / "arity.q").write_text(SCRIPT)
    run = subprocess.run([Q, "arity.q", "-q"], cwd=tmp_path, text=True,
                         capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
    rows = [line.split("\t") for line in run.stdout.splitlines() if line.count("\t") == 2]
    assert len(rows) == len(functions), (run.stdout[-2000:], run.stderr[-2000:])
    held, wrong = 0, []
    for name, kind, rank in rows:
        if int(kind) not in (LAMBDA, UNARY, OPERATOR):
            continue
        held += 1
        if int(rank) != len(functions[name]):
            wrong.append((name, functions[name], int(rank)))
    assert not wrong, wrong
    # Most of the catalogue is checkable; an interpreter that defines almost
    # none of it would otherwise pass by holding nothing.
    assert held > len(functions) // 2, (held, len(functions))
