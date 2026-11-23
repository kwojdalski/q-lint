"""Every file that declares the release's version says the same, and
`scripts/dist.py bump` moves all of them. The release workflow checks the same files against the tag."""

import hashlib
import importlib.util
import re
import shutil
from pathlib import Path

import pytest

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


def published_release(folder, files):
    """`files` written to `folder` with a SHA256SUMS of them, as the release
    workflow writes it."""
    folder.mkdir(parents=True, exist_ok=True)
    lines = []
    for name, data in files.items():
        (folder / name).write_bytes(data)
        lines.append(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
    (folder / "SHA256SUMS").write_text("".join(lines))


def test_verify_accepts_files_that_match_the_release(tmp_path):
    published_release(tmp_path, {"a.tar.gz": b"binary", "b.vsix": b"extension"})
    dist.verify(tmp_path, tmp_path / "SHA256SUMS")
    assert (tmp_path / "a.tar.gz").exists()


def test_verify_refuses_and_deletes_a_tampered_file(tmp_path):
    published_release(tmp_path, {"a.tar.gz": b"binary", "b.vsix": b"extension"})
    (tmp_path / "a.tar.gz").write_bytes(b"binarY")
    with pytest.raises(SystemExit, match="a.tar.gz"):
        dist.verify(tmp_path, tmp_path / "SHA256SUMS")
    assert not (tmp_path / "a.tar.gz").exists()
    assert (tmp_path / "b.vsix").exists()


def test_verify_refuses_sums_that_name_nothing_downloaded(tmp_path):
    published_release(tmp_path, {"a.tar.gz": b"binary"})
    (tmp_path / "a.tar.gz").unlink()
    with pytest.raises(SystemExit, match="names none"):
        dist.verify(tmp_path, tmp_path / "SHA256SUMS")


def test_download_fetches_and_checks_the_published_sums(tmp_path, monkeypatch):
    target = "x86_64-unknown-linux-gnu"
    name = f"qlinter-v9.8.7-{target}.tar.gz"
    monkeypatch.setattr(dist, "DIST", tmp_path)
    monkeypatch.setattr(dist, "host", lambda: target)
    calls = []

    def gh(*cmd, **_):
        calls.append(cmd)
        published_release(tmp_path / "v9.8.7", {name: b"binary"})
        (tmp_path / "v9.8.7" / name).write_bytes(b"tampered")

    monkeypatch.setattr(dist, "run", gh)
    with pytest.raises(SystemExit, match="mismatch"):
        dist.download(type("Args", (), {"version": "9.8.7", "all_platforms": False})())
    assert "SHA256SUMS" in calls[0]
    assert not (tmp_path / "v9.8.7" / name).exists()
