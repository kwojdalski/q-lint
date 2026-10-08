"""Every built or downloaded qlinter artifact, in one place: `dist/`.

    python3 scripts/dist.py build              # this checkout, for this machine
    python3 scripts/dist.py build --wheel      # ...and the Python wheel too
    python3 scripts/dist.py download 0.14.9    # a GitHub release, all platforms
    python3 scripts/dist.py install            # build, then install it here
    python3 scripts/dist.py install 0.14.9     # install a release (downloads it if needed)
    python3 scripts/dist.py bump 0.15.0        # set the version everywhere it is declared

Artifacts go to `dist/vX.Y.Z/`, named exactly as the GitHub release names them
(`qlinter-vX.Y.Z-aarch64-apple-darwin.tar.gz`, `qlinter-vX.Y.Z-darwin-arm64.vsix`,
...). A build of the tagged commit and the downloaded release are the same
version and share that folder. A build of anything else - uncommitted changes,
or commits since the tag - goes to `dist/vX.Y.Z-dev/`, so an unreleased build
is never mistaken for a release. Each folder gets a `SHA256SUMS`. `dist/` is
ignored by Git.

`install` puts the command-line tool in `~/.local/bin` (or `--bin-dir`) and the
extension into VS Code with `code --install-extension`. Nothing here publishes:
releases are made by pushing a tag, which the release workflow builds.
"""

import argparse
import hashlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
EXTENSION = ROOT / "editors" / "vscode"
REPO = "kwojdalski/q-lint"
# The Rust target each VS Code platform build carries, as the release does.
VSCODE = {
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
    "x86_64-unknown-linux-gnu": "linux-x64",
    "x86_64-pc-windows-msvc": "win32-x64",
}


def run(*cmd, cwd=ROOT, capture=False):
    result = subprocess.run(cmd, cwd=cwd, check=True, text=True, capture_output=capture)
    return result.stdout if capture else None


def version() -> str:
    text = (ROOT / "Cargo.toml").read_text()
    return re.search(r'(?m)^version = "([^"]+)"', text).group(1)


def host() -> str:
    return re.search(r"(?m)^host: (\S+)", run("rustc", "-vV", capture=True)).group(1)


def released_checkout(ver: str) -> bool:
    """A clean working tree at the commit the tag vX.Y.Z names."""
    dirty = run("git", "status", "--porcelain", "--untracked-files=no", capture=True).strip()
    head = run("git", "rev-parse", "HEAD", capture=True).strip()
    try:
        tag = run("git", "rev-parse", f"v{ver}^{{commit}}", capture=True).strip()
    except subprocess.CalledProcessError:
        return False
    return not dirty and head == tag


def checksums(folder: Path) -> None:
    lines = [
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n"
        for p in sorted(folder.iterdir())
        if p.is_file() and p.name != "SHA256SUMS"
    ]
    (folder / "SHA256SUMS").write_text("".join(lines))


def build(args) -> Path:
    ver = version()
    target = host()
    folder = DIST / (f"v{ver}" if released_checkout(ver) else f"v{ver}-dev")
    folder.mkdir(parents=True, exist_ok=True)
    print(f"building qlinter {ver} for {target} into {folder.relative_to(ROOT)}/")
    run("cargo", "build", "--release")
    exe = "qlinter.exe" if target.endswith("windows-msvc") else "qlinter"
    binary = ROOT / "target" / "release" / exe

    # The archive the release publishes: one directory with the binary, the
    # README and the licence.
    stem = f"qlinter-v{ver}-{target}"
    archive = folder / (f"{stem}.zip" if exe.endswith(".exe") else f"{stem}.tar.gz")
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            for f in (binary, ROOT / "README.md", ROOT / "LICENSE"):
                z.write(f, f"{stem}/{f.name}")
    else:
        with tarfile.open(archive, "w:gz") as t:
            for f in (binary, ROOT / "README.md", ROOT / "LICENSE"):
                t.add(f, f"{stem}/{f.name}")

    # The VS Code extension for this platform, carrying this binary. The
    # extension's own `server/qlinter` is a committed file; it is swapped for
    # the fresh build only while packaging, and put back after.
    if target in VSCODE and shutil.which("npx"):
        server = EXTENSION / "server" / exe
        saved = server.read_bytes() if server.exists() else None
        try:
            server.parent.mkdir(exist_ok=True)
            shutil.copy2(binary, server)
            server.chmod(0o755)
            if not (EXTENSION / "node_modules").is_dir():
                run("npm", "ci", cwd=EXTENSION)
            vsix = folder / f"qlinter-v{ver}-{VSCODE[target]}.vsix"
            run(
                "npx", "--yes", "@vscode/vsce", "package",
                "--target", VSCODE[target], "--out", str(vsix),
                cwd=EXTENSION,
            )
        finally:
            if saved is not None:
                server.write_bytes(saved)
                server.chmod(0o755)
    else:
        print("no VS Code package: npx is not installed or this platform has no build", file=sys.stderr)

    if args.wheel:
        with tempfile.TemporaryDirectory() as temporary:
            run("uv", "build", "--package", "q-lint-rs", "--wheel", "--out-dir", temporary)
            for wheel in Path(temporary).glob("*.whl"):
                shutil.copy2(wheel, folder / wheel.name)

    checksums(folder)
    for p in sorted(folder.iterdir()):
        print(f"  {p.relative_to(ROOT)}")
    return folder


def download(args) -> Path:
    ver = args.version.removeprefix("v")
    folder = DIST / f"v{ver}"
    folder.mkdir(parents=True, exist_ok=True)
    target = host()
    patterns = (
        []
        if args.all_platforms
        else ["--pattern", f"*{target}*", "--pattern", f"*-{VSCODE.get(target, target)}.vsix"]
    )
    run("gh", "release", "download", f"v{ver}", "--repo", REPO, "--dir", str(folder), "--clobber", *patterns)
    checksums(folder)
    for p in sorted(folder.iterdir()):
        print(f"  {p.relative_to(ROOT)}")
    return folder


def install(args) -> None:
    target = host()
    if args.version:
        ver = args.version.removeprefix("v")
        folder = DIST / f"v{ver}"
        if not list(folder.glob(f"*{target}*")):
            download(argparse.Namespace(version=ver, all_platforms=False))
    else:
        folder = build(argparse.Namespace(wheel=False))
        ver = folder.name.removeprefix("v").removesuffix("-dev")

    [archive] = [p for p in folder.glob(f"qlinter-v{ver}-{target}.*") if p.suffix in (".gz", ".zip")]
    exe = "qlinter.exe" if target.endswith("windows-msvc") else "qlinter"
    bin_dir = Path(args.bin_dir).expanduser()
    bin_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        if archive.suffix == ".zip":
            zipfile.ZipFile(archive).extractall(temporary)
        else:
            with tarfile.open(archive) as t:
                t.extractall(temporary, filter="data")
        [binary] = Path(temporary).rglob(exe)
        shutil.copy2(binary, bin_dir / exe)
        (bin_dir / exe).chmod(0o755)
    print(run(str(bin_dir / exe), "--version", capture=True).strip(), "->", bin_dir / exe)

    vsix = folder / f"qlinter-v{ver}-{VSCODE.get(target, '')}.vsix"
    if vsix.exists() and shutil.which("code"):
        run("code", "--install-extension", str(vsix), "--force")
        print(f"VS Code extension {ver} installed; reload the window to start it")
    else:
        print("VS Code extension not installed: no package for this platform, or no `code` on PATH")


def bump(args) -> None:
    new = args.version.removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", new):
        sys.exit(f"not a version: {args.version}")
    old = version()
    for name, pattern in [
        ("Cargo.toml", r'(?m)^version = "[^"]+"'),
        ("pyproject.toml", r'(?m)^version = "[^"]+"'),
    ]:
        path = ROOT / name
        path.write_text(re.sub(pattern, f'version = "{new}"', path.read_text(), count=1))
    package = EXTENSION / "package.json"
    data = package.read_text()
    package.write_text(re.sub(r'"version": "[^"]+"', f'"version": "{new}"', data, count=1))
    # Cargo.lock follows the build, and the extension's committed server is
    # the binary that version ships for local packaging.
    run("cargo", "build", "--release")
    shutil.copy2(ROOT / "target" / "release" / "qlinter", EXTENSION / "server" / "qlinter")
    print(f"{old} -> {new}: Cargo.toml, Cargo.lock, pyproject.toml, editors/vscode/package.json, "
          "editors/vscode/server/qlinter. Commit, tag v" + new + " and push to release.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="build this checkout into dist/")
    b.add_argument("--wheel", action="store_true", help="also build the Python wheel")
    b.set_defaults(func=build)
    d = sub.add_parser("download", help="download a GitHub release into dist/")
    d.add_argument("version")
    d.add_argument("--all-platforms", action="store_true",
                   help="every platform's files, not only this machine's")
    d.set_defaults(func=download)
    i = sub.add_parser("install", help="install the CLI and VS Code extension here")
    i.add_argument("version", nargs="?", help="a released version; default: build this checkout")
    i.add_argument("--bin-dir", default="~/.local/bin")
    i.set_defaults(func=install)
    v = sub.add_parser("bump", help="set the version in every file that declares it")
    v.add_argument("version")
    v.set_defaults(func=bump)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
