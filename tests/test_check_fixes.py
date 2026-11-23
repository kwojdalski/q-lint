"""scripts/check_fixes.py's own bookkeeping: which files it reads, and how it
decides two parse trees are the same program."""

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "check_fixes", ROOT / "scripts" / "check_fixes.py"
)
check_fixes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_fixes)


def test_a_directory_named_like_a_q_file_is_not_a_source(tmp_path):
    (tmp_path / "jlas_ml.q").mkdir()
    (tmp_path / "jlas_ml.q" / "inner.q").write_text("a:1\n")
    (tmp_path / "top.q").write_text("b:2\n")
    found = check_fixes.sources(tmp_path)
    assert found == [tmp_path / "jlas_ml.q" / "inner.q", tmp_path / "top.q"]


@pytest.mark.skipif(not shutil.which("q"), reason="Needs a q on PATH")
def test_a_lambda_in_a_query_column_is_compared_by_what_it_compiles_to(tmp_path):
    pairs = [
        [
            "update d:{[b] c:g b; c} each content from a",
            "update d:{[b] c:g[b]; c} each content from a",
        ],
        ["update d:{[b] b+1} each c from a", "update d:{[b] b+2} each c from a"],
        # A string or long-vector constant is the program, not its source text.
        ['f:{x,"ab"}', 'f:{x,"cd"}'],
        ["f:{x+1 2 3}", "f:{x+4 5 6}"],
        ['f:{x,"ab"}', 'f:{x,  "ab"}'],
    ]
    (tmp_path / "pairs.json").write_text(json.dumps(pairs))
    (tmp_path / "compare.q").write_text(check_fixes.COMPARE)
    run = subprocess.run(
        ["q", str(tmp_path / "compare.q"), "-q"],
        env={**os.environ, "PAIRS": str(tmp_path / "pairs.json")},
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=30,
        check=False,
    )
    assert json.loads(run.stdout.strip().splitlines()[-1]) == ["same", "changed", "changed", "changed", "same"]


def test_only_a_slash_in_column_0_opens_a_block_comment():
    # On KDB-X `a:1`,`  /`,`b:2` defines both: the indented slash is a comment.
    assert check_fixes.statements("a:1\n  /\nb:2\n") == ["a:1\n  /", "b:2"]
    assert check_fixes.statements("a:1\n/ \nb:2\n  \\\nc:3\n\\\nd:4\n") == ["a:1", "d:4"]
