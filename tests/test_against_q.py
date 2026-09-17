"""Check the parameter-list rules against a real q, when one is installed.

Every other test here states what the linter should say. This one asks q what
it actually does with a lambda - `value value` reports the parameter names it
bound - and holds the linter to that answer. It is how the expectations in
`tests/core.rs` were arrived at, kept runnable so they can be rechecked
against a new q release rather than trusted indefinitely.

Skipped when q is absent, which includes CI: the point is to be run by
someone who has one.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target/release/qlinter"
Q = shutil.which("q")

pytestmark = pytest.mark.skipif(
    not (Q and BINARY.is_file()),
    reason="Needs a q on PATH and the Rust release binary",
)

# Lambdas whose brackets q reads as a parameter list, and lambdas where it does
# not. The second group is what QF007 reports - QF002 for the `_` case: q
# either refuses the source ('nyi) or quietly binds x, y and z instead, giving
# the lambda a rank the source does not show.
SIGNATURES = [
    "{[a] a+1}",
    "{[a;b] a+b}",
    "{[] 42}",
    "{[a]x+1}",
    "{[ a ; b ] a}",
    "{[a_b] a_b+1}",
    "{[.q.z] 1}",
    "{[a;b;c;d;e;f;g;h] a}",
    "{[a;a] a}",
    "{[a;b;] a}",
]
NOT_SIGNATURES = [
    "{[tables[]] x+1}",
    "{[a+b] 1}",
    "{[1] x+1}",
    "{[`s] x+1}",
    "{[_] x+1}",
    "{[a b] a}",
    "{[a[0]] a}",
    "{[a:1] a}",
    "{[-1] 1}",
    '{["s"] 1}',
]


def q_parameters(sources, tmp_path):
    """What q binds as each lambda's parameters, or None if it refuses it."""
    script = tmp_path / "oracle.q"
    calls = "\n".join(
        't "%s";' % s.replace("\\", "\\\\").replace('"', '\\"') for s in sources
    )
    script.write_text(
        't:{[s]\n'
        '  r:@[{v:value value x; (1b; v 1)};s;{(0b;enlist `$x)}];\n'
        '  -1 "RESULT\\t",s,"\\t",(string first r),"\\t",(";" sv string last r);\n'
        '  };\n' + calls + "\nexit 0;\n"
    )
    out = subprocess.run([Q, str(script), "-q"], capture_output=True, text=True, timeout=60)
    answers = {}
    for line in out.stdout.splitlines():
        if line.startswith("RESULT\t"):
            _, source, parsed, names = line.split("\t", 3)
            answers[source] = (names.split(";") if names else []) if parsed == "1" else None
    return answers


def findings(source, tmp_path):
    target = tmp_path / "case.q"
    target.write_text("f:" + source + "\n")
    out = subprocess.run(
        [str(BINARY), "--format", "json", str(target)], capture_output=True, text=True
    )
    return {f["code"] for f in json.loads(out.stdout or "[]")}


def test_qf007_fires_exactly_when_q_does_not_see_a_parameter_list(tmp_path):
    answers = q_parameters(SIGNATURES + NOT_SIGNATURES, tmp_path)
    assert answers, "the q oracle produced nothing"
    for source in SIGNATURES:
        names = answers[source]
        # q bound the declared names, so the linter must not call it body text.
        assert names is not None, f"q unexpectedly refused {source!r}"
        assert "QF007" not in findings(source, tmp_path), source
    for source in NOT_SIGNATURES:
        names = answers[source]
        # Either refused, or the parameters are not the declared names.
        declared = source[source.index("[") + 1 : source.index("]")]
        assert names is None or declared.strip() not in names, (
            f"q read {source!r} as a real parameter list: {names}"
        )
        # `_` gets QF002, which says the same thing about the same brackets
        # with a more specific cause; either code is the linter agreeing.
        assert findings(source, tmp_path) & {"QF007", "QF002"}, source


def test_an_empty_slot_is_a_parameter(tmp_path):
    # `{[a;b;] ...}` is rank 3 in q; QF009 exists because the source does not
    # look like it.
    answers = q_parameters(["{[a;b;] a}"], tmp_path)
    assert len(answers["{[a;b;] a}"]) == 3
    assert "QF009" in findings("{[a;b;] a}", tmp_path)
