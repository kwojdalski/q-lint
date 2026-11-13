"""scripts/corpus.py over throwaway git repositories and a stand-in qlinter.

No network and no Rust build: the upstream is a local repository, and the
"linter" is a script that reports every line containing BAD, so what is under
test is the tool's bookkeeping - pins, upstream HEAD, the baseline - not any
rule.
"""

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("corpus", ROOT / "scripts" / "corpus.py")
corpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus)

FAKE_LINTER = """#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path(sys.argv[-1])
out = []
for f in sorted(root.rglob("*.q")):
    for n, line in enumerate(f.read_text().splitlines(), 1):
        if "BAD" in line:
            out.append({"path": str(f), "line": n, "code": "QX001", "detail": "bad"})
print(json.dumps(out))
"""


def git(*args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(repo: Path, files: dict) -> str:
    for name, text in files.items():
        (repo / name).write_text(text)
    git("add", "-A", cwd=repo)
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c", cwd=repo)
    return git("rev-parse", "HEAD", cwd=repo)


@pytest.fixture
def world(tmp_path, monkeypatch):
    """An upstream with two commits, the corpus pinned at the first, a
    stand-in linter, and corpus.py's two files moved into tmp_path."""
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    git("init", "-q", "-b", "main", cwd=upstream)
    git("config", "uploadpack.allowAnySHA1InWant", "true", cwd=upstream)
    first = commit(upstream, {"a.q": "x:1\ny:BAD 1\n"})
    second = commit(upstream, {"a.q": "/ moved down\nx:1\ny:BAD 1\nz:BAD 2\n"})
    repo = f"file://{upstream}"
    repos = tmp_path / "corpus.json"
    repos.write_text(json.dumps([{"repo": repo, "commit": first, "source": "test"}]))
    monkeypatch.setattr(corpus, "REPOS_FILE", repos)
    monkeypatch.setattr(corpus, "BASELINE_FILE", tmp_path / "baseline.json")
    linter = tmp_path / "qlinter"
    linter.write_text(FAKE_LINTER)
    linter.chmod(0o755)
    return {
        "repo": repo,
        "first": first,
        "second": second,
        "dir": tmp_path / "q",
        "linter": str(linter),
    }


def lint(world, *extra):
    return corpus.main(["lint", str(world["dir"]), "--binary", world["linter"], *extra])


def test_sync_checks_out_the_pin_and_status_sees_upstream_move(world, capsys):
    corpus.main(["sync", str(world["dir"])])
    where = corpus.target(world["dir"], world["repo"])
    assert git("rev-parse", "HEAD", cwd=where) == world["first"]
    corpus.main(["status"])
    out = capsys.readouterr().out
    assert f"upstream {world['second'][:8]}" in out and "1 of 1 have moved" in out


def test_a_finding_not_in_the_baseline_is_new_until_accepted(world, capsys):
    corpus.main(["sync", str(world["dir"])])
    assert lint(world) == 1
    assert "1 new, 0 gone" in capsys.readouterr().out
    corpus.main(["accept", str(world["dir"]), "--binary", world["linter"]])
    assert lint(world) == 0


def test_a_known_finding_on_a_moved_line_is_not_new(world, capsys):
    corpus.main(["sync", str(world["dir"])])
    corpus.main(["accept", str(world["dir"]), "--binary", world["linter"]])
    capsys.readouterr()
    # Upstream adds a line above it and a new BAD below: only that one is new.
    corpus.main(["sync", str(world["dir"]), "--latest"])
    assert lint(world) == 1
    out = capsys.readouterr().out
    assert "a.q:4 QX001" in out and "1 new, 0 gone" in out


def test_pin_records_the_checked_out_commit(world):
    corpus.main(["sync", str(world["dir"]), "--latest"])
    corpus.main(["pin", str(world["dir"])])
    assert json.loads(corpus.REPOS_FILE.read_text())[0]["commit"] == world["second"]


def test_only_selects_and_refuses_a_pattern_matching_nothing(world):
    with pytest.raises(SystemExit, match="matches no repository"):
        corpus.main(["status", "--only", "nosuchrepo"])


def test_the_shipped_repository_list_is_well_formed():
    repos = json.loads((ROOT / "scripts" / "corpus.json").read_text())
    assert len({r["repo"] for r in repos}) == len(repos), "a repository listed twice"
    assert all(len(r["commit"]) == 40 for r in repos)
