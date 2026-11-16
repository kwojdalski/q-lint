"""scripts/check_fixes.py's own bookkeeping: which files it reads, and how it
decides two parse trees are the same program."""

import importlib.util
import json
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
