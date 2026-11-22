"""Every file that declares the release's version says the same, and
`scripts/dist.py bump` moves all of them. The release workflow checks the same files against the tag."""

import importlib.util
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("dist", ROOT / "scripts" / "dist.py")
dist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dist)


def test_every_declared_version_is_the_release_version():
    found = dist.declared_versions()
    assert None not in found.values(), found
    assert set(found.values()) == {dist.version()}, found


def test_the_release_workflow_checks_every_declared_file():
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text()
    checked = set(re.findall(r"(?m)^\s+check (\S+)", workflow))
    assert checked == set(dist.declared_versions()), checked


def test_bump_moves_every_declared_version(tmp_path, monkeypatch):
    old = dist.version()
    for name in dist.declared_versions():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / name, tmp_path / name)
    monkeypatch.setattr(dist, "ROOT", tmp_path)
    monkeypatch.setattr(dist, "EXTENSION", tmp_path / "editors" / "vscode")
    builds = []
    monkeypatch.setattr(dist, "run", lambda *cmd, **_: builds.append(cmd))
    dist.bump(type("Args", (), {"version": "v9.8.7"})())
    assert set(dist.declared_versions().values()) == {"9.8.7"}
    assert builds == [("cargo", "build", "--release")]
