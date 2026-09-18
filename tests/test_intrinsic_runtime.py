"""Execute only curated fixture expressions in q, never user lint input."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
Q = shutil.which("q")
BINARY = ROOT / "target/release/qlinter"
CASES = json.loads((ROOT / "tests/intrinsic_runtime.json").read_text())
pytestmark = pytest.mark.skipif(not Q or not BINARY.exists(), reason="requires q and release binary")


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["code"])
@pytest.mark.parametrize("multiline", [False, True])
def test_runtime_failure_and_valid_counterpart(case, multiline, tmp_path):
    for key in ["bad", "good"]:
        expression = case[key]
        if multiline and "\n" not in expression:
            name, tail = expression.split("[", 1)
            body = re.sub(r'"(?:[^"\\]|\\.)*"|;',
                          lambda m: ";\n " if m[0] == ";" else m[0], tail[:-1])
            expression = name + "[\n / argument\n " + body + "\n ]"
        # A function allows multiline source to be compiled and then evaluated.
        source = "f:{[]\n " + expression + "\n };\nf[]"
        script = tmp_path / "oracle.q"
        script.write_text(
            'r:@[{value x;"OK"};' + json.dumps(source) + ';{x}];\n'
            '-1 "RESULT:",r;\nexit 0;\n'
        )
        run = subprocess.run([Q, str(script), "-q"], text=True, capture_output=True, timeout=15)
        assert "RESULT:" + (case["error"] if key == "bad" else "OK") in run.stdout.splitlines(), (source, run.stdout, run.stderr)
        target = tmp_path / "fixture.q"
        target.write_text(source)
        lint = subprocess.run([str(BINARY), "--profile", "general", "--format", "json", str(target)], text=True, capture_output=True, timeout=15)
        assert lint.returncode in [0, 1], lint.stderr
        findings = json.loads(lint.stdout)
        assert {f["code"] for f in findings} == ({case["code"]} if key == "bad" else set()), source
        if findings:
            assert findings[0]["line"] == (3 if case["code"] == "QA002" else 2), findings
