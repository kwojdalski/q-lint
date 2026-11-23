"""What ships around the binary - its Cargo metadata, the CI that builds it
and the files other tools read to run it - says what the sources say. Each
of these is read by something this repository never runs (crates.io, a
GitHub runner, pre-commit), so a test here is the only place a typo shows."""

import json
import re
import subprocess
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[1]


def workflow(name):
    return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text())


def steps(job):
    return [s.get("run", "") or s.get("uses", "") for s in job["steps"]]


def test_cargo_metadata_declares_the_package():
    out = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--no-deps", "--offline"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    [package] = json.loads(out)["packages"]
    assert package["license"] == "MIT"
    assert (ROOT / "LICENSE").read_text().startswith("MIT License")
    assert package["repository"] == "https://github.com/kwojdalski/q-lint"
    assert package["description"]
    assert package["keywords"]
    assert re.fullmatch(r"\d+\.\d+", package["rust_version"])


def test_ci_builds_with_the_declared_msrv():
    declared = re.search(r'(?m)^rust-version = "([^"]+)"', (ROOT / "Cargo.toml").read_text())[1]
    job = workflow("ci.yml")["jobs"]["msrv"]
    [toolchain] = [s for s in job["steps"] if s.get("uses", "").startswith("dtolnay/rust-toolchain")]
    assert str(toolchain["with"]["toolchain"]) == declared
    assert "cargo build --locked --all-targets" in steps(job)
