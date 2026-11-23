"""`scripts/dist.py` offline: every subcommand against a fake checkout and a
fake release directory, with each command it would run - cargo, git, gh,
npx, code, the installed binary - recorded instead of run. Version bumping
and SHA256SUMS verification are in test_release_versions.py; what is here is
the rest: the names artifacts get, which platform is this one, where
`install` puts things, and which files `download` asks for."""

import importlib.util
import io
import os
import tarfile
import zipfile
from argparse import Namespace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def dist(tmp_path, monkeypatch):
    """A fresh copy of the module, pointed at a fake checkout in tmp_path,
    whose `run` records each command and runs none."""
    spec = importlib.util.spec_from_file_location("dist_offline", ROOT / "scripts" / "dist.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checkout = tmp_path / "checkout"
    (checkout / "editors" / "vscode").mkdir(parents=True)
    (checkout / "Cargo.toml").write_text('[package]\nname = "q-lint-rs"\nversion = "9.8.7"\n')
    (checkout / "README.md").write_text("readme\n")
    (checkout / "LICENSE").write_text("MIT License\n")
    monkeypatch.setattr(module, "ROOT", checkout)
    monkeypatch.setattr(module, "DIST", checkout / "dist")
    monkeypatch.setattr(module, "EXTENSION", checkout / "editors" / "vscode")
    module.ran = []
    module.answers = {}

    def run(*cmd, cwd=None, capture=False):
        module.ran.append(cmd)
        for prefix, answer in module.answers.items():
            if cmd[: len(prefix)] == prefix:
                if isinstance(answer, Exception):
                    raise answer
                return answer(cmd) if callable(answer) else answer
        return "" if capture else None

    monkeypatch.setattr(module, "run", run)
    return module


def test_host_is_the_target_rustc_reports(dist):
    dist.answers[("rustc", "-vV")] = "rustc 1.90.0\nbinary: rustc\nhost: aarch64-apple-darwin\nrelease: 1.90.0\n"
    assert dist.host() == "aarch64-apple-darwin"


def test_version_is_cargo_tomls(dist):
    assert dist.version() == "9.8.7"


def test_every_vscode_platform_is_one_the_release_builds():
    spec = importlib.util.spec_from_file_location("dist_names", ROOT / "scripts" / "dist.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    release = (ROOT / ".github" / "workflows" / "release.yml").read_text()
    for target, platform in module.VSCODE.items():
        assert target in release, target
        assert platform in release, platform


def test_a_released_checkout_is_clean_and_at_the_tag(dist):
    dist.answers[("git", "status")] = ""
    dist.answers[("git", "rev-parse", "HEAD")] = "abc\n"
    dist.answers[("git", "rev-parse", "v9.8.7^{commit}")] = "abc\n"
    assert dist.released_checkout("9.8.7")
    dist.answers[("git", "status")] = " M src/lib.rs\n"
    assert not dist.released_checkout("9.8.7")
    dist.answers[("git", "status")] = ""
    dist.answers[("git", "rev-parse", "v9.8.7^{commit}")] = "def\n"
    assert not dist.released_checkout("9.8.7")


def test_no_tag_is_no_released_checkout(dist):
    import subprocess

    dist.answers[("git", "rev-parse", "v9.8.7^{commit}")] = subprocess.CalledProcessError(128, "git")
    assert not dist.released_checkout("9.8.7")


def test_checksums_list_every_file_but_themselves(dist, tmp_path):
    folder = tmp_path / "f"
    folder.mkdir()
    (folder / "b.vsix").write_bytes(b"b")
    (folder / "a.tar.gz").write_bytes(b"a")
    (folder / "SHA256SUMS").write_text("stale\n")
    dist.checksums(folder)
    lines = (folder / "SHA256SUMS").read_text().splitlines()
    assert [line.split()[1] for line in lines] == ["a.tar.gz", "b.vsix"]
    assert lines[0].split()[0] == "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"


def fake_build(dist, monkeypatch, target, released, npx):
    exe = "qlinter.exe" if target.endswith("windows-msvc") else "qlinter"
    binary = dist.ROOT / "target" / "release" / exe
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"\x7fELF fake")
    monkeypatch.setattr(dist, "host", lambda: target)
    monkeypatch.setattr(dist, "released_checkout", lambda ver: released)
    monkeypatch.setattr(dist.shutil, "which", lambda name: "/usr/bin/npx" if npx and name == "npx" else None)
    (dist.EXTENSION / "node_modules").mkdir()
    return dist.build(Namespace(wheel=False))


def test_build_names_the_archive_and_vsix_as_the_release(dist, monkeypatch):
    folder = fake_build(dist, monkeypatch, "aarch64-apple-darwin", released=True, npx=True)
    assert folder == dist.DIST / "v9.8.7"
    archive = folder / "qlinter-v9.8.7-aarch64-apple-darwin.tar.gz"
    with tarfile.open(archive) as t:
        assert sorted(t.getnames()) == [
            "qlinter-v9.8.7-aarch64-apple-darwin/LICENSE",
            "qlinter-v9.8.7-aarch64-apple-darwin/README.md",
            "qlinter-v9.8.7-aarch64-apple-darwin/qlinter",
        ]
    assert ("cargo", "build", "--release") in dist.ran
    [vsce] = [c for c in dist.ran if "@vscode/vsce" in c]
    assert vsce[vsce.index("--target") + 1] == "darwin-arm64"
    assert vsce[vsce.index("--out") + 1] == str(folder / "qlinter-v9.8.7-darwin-arm64.vsix")
    # The extension carries the binary just built, executable.
    server = dist.EXTENSION / "server" / "qlinter"
    assert server.read_bytes() == b"\x7fELF fake" and os.access(server, os.X_OK)
    assert (folder / "SHA256SUMS").read_text().count("\n") == 1


def test_build_of_anything_but_the_tag_is_a_dev_build(dist, monkeypatch):
    folder = fake_build(dist, monkeypatch, "x86_64-unknown-linux-gnu", released=False, npx=False)
    assert folder.name == "v9.8.7-dev"
    assert (folder / "qlinter-v9.8.7-x86_64-unknown-linux-gnu.tar.gz").is_file()
    assert not [c for c in dist.ran if "@vscode/vsce" in c]


def test_build_on_windows_zips_the_exe(dist, monkeypatch):
    folder = fake_build(dist, monkeypatch, "x86_64-pc-windows-msvc", released=True, npx=False)
    with zipfile.ZipFile(folder / "qlinter-v9.8.7-x86_64-pc-windows-msvc.zip") as z:
        assert "qlinter-v9.8.7-x86_64-pc-windows-msvc/qlinter.exe" in z.namelist()


def download_args(all_platforms=False):
    return Namespace(version="v9.8.7", all_platforms=all_platforms)


def test_download_asks_for_this_platforms_files_and_the_sums(dist, monkeypatch):
    monkeypatch.setattr(dist, "host", lambda: "x86_64-apple-darwin")
    dist.download(download_args())
    [gh] = dist.ran
    assert gh[:3] == ("gh", "release", "download") and gh[3] == "v9.8.7"
    assert gh[gh.index("--repo") + 1] == "kwojdalski/q-lint"
    patterns = [gh[i + 1] for i, a in enumerate(gh) if a == "--pattern"]
    assert patterns == ["*x86_64-apple-darwin*", "*-darwin-x64.vsix", "SHA256SUMS"]


def test_download_of_every_platform_asks_for_everything(dist, monkeypatch):
    monkeypatch.setattr(dist, "host", lambda: "x86_64-apple-darwin")
    dist.download(download_args(all_platforms=True))
    assert "--pattern" not in dist.ran[0]


def test_a_release_without_sums_is_downloaded_with_a_warning(dist, monkeypatch, capsys):
    monkeypatch.setattr(dist, "host", lambda: "x86_64-unknown-linux-gnu")

    def gh(cmd):
        folder = Path(cmd[cmd.index("--dir") + 1])
        (folder / "qlinter-v9.8.7-x86_64-unknown-linux-gnu.tar.gz").write_bytes(b"old")

    dist.answers[("gh",)] = gh
    folder = dist.download(download_args())
    assert "unverified" in capsys.readouterr().err
    assert "qlinter-v9.8.7-x86_64-unknown-linux-gnu.tar.gz" in (folder / "SHA256SUMS").read_text()


def test_download_ignores_the_folders_own_old_sums(dist, monkeypatch, capsys):
    """A SHA256SUMS `build` left in the folder vouches for nothing gh fetched."""
    monkeypatch.setattr(dist, "host", lambda: "x86_64-unknown-linux-gnu")
    folder = dist.DIST / "v9.8.7"
    folder.mkdir(parents=True)
    (folder / "SHA256SUMS").write_text("0" * 64 + "  qlinter-v9.8.7-x86_64-unknown-linux-gnu.tar.gz\n")
    dist.answers[("gh",)] = lambda cmd: (folder / "qlinter-v9.8.7-x86_64-unknown-linux-gnu.tar.gz").write_bytes(b"x")
    dist.download(download_args())
    assert "unverified" in capsys.readouterr().err


def release_archive(folder, target, exe="qlinter"):
    """The archive the release publishes for `target`, holding a binary."""
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"qlinter-v9.8.7-{target}"
    if exe.endswith(".exe"):
        with zipfile.ZipFile(folder / f"{stem}.zip", "w") as z:
            z.writestr(f"{stem}/{exe}", b"binary")
            z.writestr(f"{stem}/README.md", b"readme")
    else:
        with tarfile.open(folder / f"{stem}.tar.gz", "w:gz") as t:
            for name, data in [(exe, b"binary"), ("README.md", b"readme")]:
                info = tarfile.TarInfo(f"{stem}/{name}")
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))


def test_install_puts_the_released_binary_in_the_bin_dir_and_the_vsix_in_code(dist, monkeypatch, tmp_path):
    target = "aarch64-apple-darwin"
    monkeypatch.setattr(dist, "host", lambda: target)
    folder = dist.DIST / "v9.8.7"
    release_archive(folder, target)
    (folder / "qlinter-v9.8.7-darwin-arm64.vsix").write_bytes(b"vsix")
    monkeypatch.setattr(dist.shutil, "which", lambda name: "/usr/bin/code" if name == "code" else None)
    monkeypatch.setattr(dist, "download", lambda args: pytest.fail("the release is already here"))
    bin_dir = tmp_path / "bin"
    dist.answers[(str(bin_dir / "qlinter"), "--version")] = "qlinter 9.8.7\n"
    dist.install(Namespace(version="9.8.7", bin_dir=str(bin_dir)))
    installed = bin_dir / "qlinter"
    assert installed.read_bytes() == b"binary" and os.access(installed, os.X_OK)
    assert ("code", "--install-extension", str(folder / "qlinter-v9.8.7-darwin-arm64.vsix"), "--force") in dist.ran


def test_install_downloads_a_release_not_yet_here(dist, monkeypatch, tmp_path):
    target = "x86_64-unknown-linux-gnu"
    monkeypatch.setattr(dist, "host", lambda: target)
    monkeypatch.setattr(dist.shutil, "which", lambda name: None)
    asked = []

    def download(args):
        asked.append(args)
        release_archive(dist.DIST / "v9.8.7", target)

    monkeypatch.setattr(dist, "download", download)
    dist.install(Namespace(version="v9.8.7", bin_dir=str(tmp_path / "bin")))
    assert asked == [Namespace(version="9.8.7", all_platforms=False)]
    assert (tmp_path / "bin" / "qlinter").read_bytes() == b"binary"
    assert not [c for c in dist.ran if c[0] == "code"]


def test_install_on_windows_unzips_the_exe(dist, monkeypatch, tmp_path):
    target = "x86_64-pc-windows-msvc"
    monkeypatch.setattr(dist, "host", lambda: target)
    monkeypatch.setattr(dist.shutil, "which", lambda name: None)
    release_archive(dist.DIST / "v9.8.7", target, exe="qlinter.exe")
    dist.install(Namespace(version="9.8.7", bin_dir=str(tmp_path / "bin")))
    assert (tmp_path / "bin" / "qlinter.exe").read_bytes() == b"binary"


def test_install_without_a_version_builds_and_installs_the_dev_build(dist, monkeypatch, tmp_path):
    target = "x86_64-unknown-linux-gnu"
    monkeypatch.setattr(dist, "host", lambda: target)
    monkeypatch.setattr(dist.shutil, "which", lambda name: None)
    built = dist.DIST / "v9.8.7-dev"
    release_archive(built, target)
    monkeypatch.setattr(dist, "build", lambda args: built)
    dist.install(Namespace(version=None, bin_dir=str(tmp_path / "bin")))
    assert (tmp_path / "bin" / "qlinter").read_bytes() == b"binary"


def test_install_expands_a_home_relative_bin_dir(dist, monkeypatch, tmp_path):
    target = "x86_64-unknown-linux-gnu"
    monkeypatch.setattr(dist, "host", lambda: target)
    monkeypatch.setattr(dist.shutil, "which", lambda name: None)
    monkeypatch.setenv("HOME", str(tmp_path))
    release_archive(dist.DIST / "v9.8.7", target)
    dist.install(Namespace(version="9.8.7", bin_dir="~/.local/bin"))
    assert (tmp_path / ".local" / "bin" / "qlinter").is_file()


@pytest.mark.parametrize(
    "argv, command, values",
    [
        (["build"], "build", {"wheel": False}),
        (["build", "--wheel"], "build", {"wheel": True}),
        (["download", "0.14.9"], "download", {"version": "0.14.9", "all_platforms": False}),
        (["download", "0.14.9", "--all-platforms"], "download", {"all_platforms": True}),
        (["install"], "install", {"version": None, "bin_dir": "~/.local/bin"}),
        (["install", "0.14.9", "--bin-dir", "/opt/bin"], "install", {"version": "0.14.9", "bin_dir": "/opt/bin"}),
        (["bump", "1.2.3"], "bump", {"version": "1.2.3"}),
    ],
)
def test_each_subcommand_reaches_its_function(dist, monkeypatch, argv, command, values):
    called = []
    for name in ["build", "download", "install", "bump"]:
        monkeypatch.setattr(dist, name, lambda args, name=name: called.append((name, args)))
    monkeypatch.setattr(dist.sys, "argv", ["dist.py", *argv])
    dist.main()
    [(name, args)] = called
    assert name == command
    for key, value in values.items():
        assert getattr(args, key) == value


def test_bump_refuses_what_is_not_a_version(dist):
    with pytest.raises(SystemExit, match="not a version"):
        dist.bump(Namespace(version="1.2"))
    assert dist.ran == []
