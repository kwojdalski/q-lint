"""`scripts/check_invariance.py` fails when findings move with a rewrite that
leaves the program alone, and reads the q in this tree - `.q` files and the
cases of `tests/cases` - as CI runs it. Each linter here is a stand-in, so
the check is tested without the corpus or a build."""

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_invariance.py"
spec = importlib.util.spec_from_file_location("check_invariance", SCRIPT)
check_invariance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_invariance)


def linter(tmp_path, finds):
    """A stand-in qlinter whose one finding per file is wherever `finds`
    (a Python expression over the file's `lines`) puts it."""
    script = tmp_path / "fake-qlinter"
    script.write_text(f"""#!{sys.executable}
import json, sys
out = []
for path in [a for a in sys.argv[1:] if a.endswith(".q")]:
    lines = open(path, newline="").read().replace("\\r\\n", "\\n").split("\\n")
    line = {finds}
    out.append({{"path": path, "line": line, "column": 1, "code": "QX001"}})
print(json.dumps(out))
""")
    script.chmod(0o755)
    return script


def run(binary, *roots):
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(binary), *map(str, roots)],
        capture_output=True, text=True,
    )


def test_a_linter_whose_findings_follow_the_code_passes(tmp_path):
    (tmp_path / "a.q").write_text("f:{x}\ng:{y}\n")
    honest = linter(tmp_path, "next(i + 1 for i, l in enumerate(lines) if l.startswith('g'))")
    result = run(honest, tmp_path / "a.q")
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_linter_that_ignores_a_moved_line_fails(tmp_path):
    (tmp_path / "a.q").write_text("f:{x}\ng:{y}\n")
    broken = linter(tmp_path, "2")
    result = run(broken, tmp_path / "a.q")
    assert result.returncode == 1
    assert "shift    1 of 1 files differ" in result.stdout


def test_a_linter_that_a_trailing_comment_moves_fails(tmp_path):
    (tmp_path / "a.q").write_text("f:{x}\ng:{y}\n")
    broken = linter(tmp_path, "1 + sum(' / note' in l for l in lines)")
    result = run(broken, tmp_path / "a.q")
    assert result.returncode == 1
    assert "comment  1 of 1 files differ" in result.stdout


def test_cases_are_split_and_profiled_as_the_case_runner_does(tmp_path):
    (tmp_path / "x.cases").write_text(
        "=== QE001 profile: general | a\nf:{\n\n=== clean | b\ng:1\n=== QF001 profile: every | c\nh:2\n"
    )
    assert check_invariance.cases(tmp_path / "x.cases") == [
        (f"{tmp_path / 'x.cases'}:1", "general", "f:{"),
        (f"{tmp_path / 'x.cases'}:4", "style", "g:1"),
        (f"{tmp_path / 'x.cases'}:6", "every", "h:2"),
    ]


def test_the_tree_has_q_for_ci_to_check():
    found = check_invariance.sources([ROOT / "examples", ROOT / "tests" / "corpus", ROOT / "tests" / "cases"])
    assert len(found) > 1000
    assert {profile for _, profile, _ in found} <= set(check_invariance.PROFILES)


def test_an_indented_slash_opens_no_block_comment():
    # On KDB-X `  /` is a comment line and `  \` neither closes nor ends.
    out = check_invariance.commented("a:1\n  /\nb:2\n").split("\n")
    assert out == ["a:1 / note", "  /", "b:2 / note", ""]
    out = check_invariance.commented("/\na:1\n  \\\nb:2\n\\\nc:3\n").split("\n")
    assert out == ["/", "a:1", "  \\", "b:2", "\\", "c:3 / note", ""]
